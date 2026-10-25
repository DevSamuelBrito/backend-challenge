import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../../shared/application/clock.port";
import { ID_GENERATOR, type IdGenerator } from "../../../shared/application/id-generator.port";
import {
  type Repositories,
  UNIT_OF_WORK,
  type UnitOfWork,
} from "../../../shared/application/unit-of-work.port";
import type { Money } from "../../../shared/domain/money";
import type { Wallet } from "../../wallet/domain/wallet";
import { WalletNotFoundError } from "../../wallet/domain/wallet-errors";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import type { FailureCode } from "../domain/failure-code";
import { backoffDelayMs } from "../domain/pending-reference-policy";
import { WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from "../domain/wager-transaction-errors";
import { computePayloadHash } from "./payload-hash";
import type { ProcessWagerTransactionCommand } from "./process-wager-transaction.command";
import { WagerSettlement } from "./wager-settlement";
import { DuplicateTransactionError } from "./wagering-errors";

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance: Money;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerTransaction {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly settlement: WagerSettlement,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const payloadHash = computePayloadHash(command);

    try {
      return await this.attempt(command, payloadHash);
    } catch (error) {
      if (!(error instanceof DuplicateTransactionError)) {
        throw error;
      }
    }

    return this.retryAfterDuplicate(command, payloadHash);
  }

  private async retryAfterDuplicate(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    try {
      return await this.attempt(command, payloadHash);
    } catch (error) {
      if (error instanceof DuplicateTransactionError) {
        throw this.conflictFor(error, command);
      }

      throw error;
    }
  }

  private attempt(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const at = this.clock.now();

    return this.unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(command.walletId);

      if (!wallet) {
        throw new WalletNotFoundError(command.walletId);
      }

      const known = await this.findKnown(repositories, command, payloadHash);

      if (known) {
        return this.resultOf(known, wallet, true);
      }

      const transaction = WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: at,
      });

      const settled = await this.settlement.settle(repositories, wallet, transaction, at);

      if (settled.kind === "waiting") {
        transaction.markPendingReference(new Date(at.getTime() + backoffDelayMs(0)));
      }

      await this.persist(repositories, {
        wallet,
        transaction,
        entry: settled.kind === "settled" ? settled.entry : undefined,
        at,
      });

      return this.resultOf(transaction, wallet, false);
    });
  }

  private async findKnown(
    { transactions }: Repositories,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<WagerTransaction | undefined> {
    const byKey = await transactions.findByIdempotencyKey(command.idempotencyKey);

    if (byKey) {
      if (!byKey.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError(command.idempotencyKey);
      }

      return byKey;
    }

    const byExternalId = await transactions.findByProviderAndExternalId(
      command.providerId,
      command.externalTransactionId,
    );

    if (byExternalId) {
      throw new ExternalTransactionConflictError(command.providerId, command.externalTransactionId);
    }

    return undefined;
  }

  private async persist(
    repositories: Repositories,
    outcome: {
      wallet: Wallet;
      transaction: WagerTransaction;
      entry: WalletLedgerEntry | undefined;
      at: Date;
    },
  ): Promise<void> {
    const { wallet, transaction, entry, at } = outcome;

    await repositories.transactions.add(transaction);
    await this.settlement.persistMovement(repositories, wallet, entry);

    if (transaction.status === WagerTransactionStatus.PendingReference) {
      await this.settlement.publishPendingReference(repositories.outbox, transaction, at);
      return;
    }

    await this.settlement.publishOutcome(repositories.outbox, transaction, entry, at);
  }

  private resultOf(
    transaction: WagerTransaction,
    wallet: Wallet,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      ...(transaction.failureCode && { failureCode: transaction.failureCode }),
      balance: transaction.balanceAfter ?? wallet.balance,
      idempotentReplay,
    };
  }

  private conflictFor(error: DuplicateTransactionError, command: ProcessWagerTransactionCommand) {
    return error.constraint === "idempotency_key"
      ? new IdempotencyConflictError(command.idempotencyKey)
      : new ExternalTransactionConflictError(command.providerId, command.externalTransactionId);
  }
}
