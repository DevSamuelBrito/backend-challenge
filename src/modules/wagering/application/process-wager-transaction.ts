import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../../shared/application/clock.port";
import { ID_GENERATOR, type IdGenerator } from "../../../shared/application/id-generator.port";
import {
  type Repositories,
  UNIT_OF_WORK,
  type UnitOfWork,
} from "../../../shared/application/unit-of-work.port";
import type { Money } from "../../../shared/domain/money";
import type { EventContext, IntegrationEvent } from "../../../shared/events/integration-event";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { WalletBalanceChanged } from "../../wallet/domain/events/wallet-balance-changed";
import { LedgerDirection } from "../../wallet/domain/ledger-direction";
import type { Wallet } from "../../wallet/domain/wallet";
import { InsufficientFundsError, WalletNotFoundError } from "../../wallet/domain/wallet-errors";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import { WagerTransactionPendingReference } from "../domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected";
import { FailureCode } from "../domain/failure-code";
import { evaluateReference, type ReferenceLookup } from "../domain/reference-policy";
import { WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from "../domain/wager-transaction-errors";
import { computePayloadHash } from "./payload-hash";
import type { ProcessWagerTransactionCommand } from "./process-wager-transaction.command";
import { DuplicateTransactionError } from "./wagering-errors";

const PENDING_REFERENCE_FIRST_RETRY_DELAY_MS = 1000;

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

      const entry = await this.decide(repositories, wallet, transaction, at);

      await this.persist(repositories, { command, wallet, transaction, entry, at });

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

  private async decide(
    repositories: Repositories,
    wallet: Wallet,
    transaction: WagerTransaction,
    at: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    const failure = this.preconditionFailure(wallet, transaction);

    if (failure) {
      transaction.reject(failure, wallet.balance, at);
      return undefined;
    }

    const lookup = await this.lookupReference(repositories, transaction);
    const decision = evaluateReference(transaction, lookup);

    switch (decision.status) {
      case WagerTransactionStatus.Rejected:
        transaction.reject(decision.failureCode, wallet.balance, at);
        return undefined;
      case WagerTransactionStatus.PendingReference:
        transaction.markPendingReference(
          new Date(at.getTime() + PENDING_REFERENCE_FIRST_RETRY_DELAY_MS),
        );
        return undefined;
      case WagerTransactionStatus.Processed:
        return this.applyMovement(wallet, transaction, lookup.reference, decision, at);
    }
  }

  private async lookupReference(
    { transactions }: Repositories,
    transaction: WagerTransaction,
  ): Promise<ReferenceLookup> {
    const { referenceExternalTransactionId } = transaction;

    if (!referenceExternalTransactionId) {
      return { reference: undefined, alreadyReversed: false };
    }

    const reference = await transactions.findByProviderAndExternalId(
      transaction.providerId,
      referenceExternalTransactionId,
    );

    const alreadyReversed =
      reference !== undefined && transaction.requiresReference()
        ? await transactions.hasProcessedReversalOf(reference.id)
        : false;

    return { reference, alreadyReversed };
  }

  private applyMovement(
    wallet: Wallet,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    decision: { referenceTransactionId: string | undefined },
    at: Date,
  ): WalletLedgerEntry | undefined {
    const { referenceTransactionId } = decision;

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(referenceTransactionId, wallet.balance, at);
      return undefined;
    }

    const movement = {
      entryId: this.ids.next(),
      transactionId: transaction.id,
      money: transaction.money,
      at,
    };

    try {
      const entry =
        transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);

      transaction.markProcessed(referenceTransactionId, wallet.balance, at);

      return entry;
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        transaction.reject(transaction.insufficientFundsFailureCode(), wallet.balance, at);
        return undefined;
      }

      throw error;
    }
  }

  private preconditionFailure(
    wallet: Wallet,
    transaction: WagerTransaction,
  ): FailureCode | undefined {
    if (transaction.playerId !== wallet.playerId) {
      return FailureCode.WalletPlayerMismatch;
    }

    if (transaction.money.currency !== wallet.currency) {
      return FailureCode.CurrencyMismatch;
    }

    return undefined;
  }

  private async persist(
    { wallets, transactions, ledger, outbox }: Repositories,
    outcome: {
      command: ProcessWagerTransactionCommand;
      wallet: Wallet;
      transaction: WagerTransaction;
      entry: WalletLedgerEntry | undefined;
      at: Date;
    },
  ): Promise<void> {
    const { command, wallet, transaction, entry, at } = outcome;

    await transactions.add(transaction);

    if (entry) {
      await ledger.append(entry);
      await wallets.save(wallet);
    }

    const correlationId = this.ids.next();
    const contextFor = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId,
      causationId: command.idempotencyKey,
      occurredAt: at,
    });
    const publish = (event: IntegrationEvent<unknown>) => outbox.add(OutboxMessage.enqueue(event));

    if (transaction.status === WagerTransactionStatus.Processed) {
      await publish(WagerTransactionProcessed.from(transaction, contextFor()));
    }

    if (entry) {
      await publish(WalletBalanceChanged.from(entry, contextFor()));
    }

    if (transaction.status === WagerTransactionStatus.Rejected) {
      await publish(WagerTransactionRejected.from(transaction, contextFor()));
    }

    if (transaction.status === WagerTransactionStatus.PendingReference) {
      await publish(WagerTransactionPendingReference.from(transaction, contextFor()));
    }
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
