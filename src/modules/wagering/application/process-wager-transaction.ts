import { Inject, Injectable, Logger } from "@nestjs/common";
import { CLOCK, type Clock } from "../../../shared/application/clock.port";
import { ID_GENERATOR, type IdGenerator } from "../../../shared/application/id-generator.port";
import {
  METRICS,
  type Metrics,
  measureLockWait,
  NO_OP_METRICS,
} from "../../../shared/application/metrics.port";
import { enrichContext } from "../../../shared/application/request-context";
import {
  type Repositories,
  UNIT_OF_WORK,
  type UnitOfWork,
} from "../../../shared/application/unit-of-work.port";
import type { Money } from "../../../shared/domain/money";
import type { InboxRepository } from "../../messaging/application/inbox.repository";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import { InboxPayloadMismatchError } from "../../messaging/domain/messaging-errors";
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
import { computeInboxPayloadHash, computePayloadHash } from "./payload-hash";
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

export interface InboxContext {
  consumerName: string;
  messageId: string;
}

export interface MessageAlreadyProcessed {
  messageAlreadyProcessed: true;
}

export function isMessageAlreadyProcessed(
  outcome: ProcessWagerTransactionResult | MessageAlreadyProcessed,
): outcome is MessageAlreadyProcessed {
  return "messageAlreadyProcessed" in outcome;
}

@Injectable()
export class ProcessWagerTransaction {
  private readonly logger = new Logger(ProcessWagerTransaction.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly settlement: WagerSettlement,
    @Inject(METRICS) private readonly metrics: Metrics = NO_OP_METRICS,
  ) {}

  execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult>;
  execute(
    command: ProcessWagerTransactionCommand,
    inbox: InboxContext,
  ): Promise<ProcessWagerTransactionResult | MessageAlreadyProcessed>;
  async execute(
    command: ProcessWagerTransactionCommand,
    inbox?: InboxContext,
  ): Promise<ProcessWagerTransactionResult | MessageAlreadyProcessed> {
    const source = inbox ? "sqs" : "http";
    const startedAt = performance.now();
    enrichContext({ walletId: command.walletId, providerId: command.providerId });

    try {
      const outcome = await this.run(command, inbox);
      this.record(command, outcome, source);

      return outcome;
    } finally {
      this.metrics.processingDuration(source, (performance.now() - startedAt) / 1000);
    }
  }

  private async run(
    command: ProcessWagerTransactionCommand,
    inbox: InboxContext | undefined,
  ): Promise<ProcessWagerTransactionResult | MessageAlreadyProcessed> {
    const payloadHash = computePayloadHash(command);

    try {
      return await this.attempt(command, payloadHash, inbox);
    } catch (error) {
      if (!(error instanceof DuplicateTransactionError)) {
        throw error;
      }
    }

    return this.retryAfterDuplicate(command, payloadHash, inbox);
  }

  private record(
    command: ProcessWagerTransactionCommand,
    outcome: ProcessWagerTransactionResult | MessageAlreadyProcessed,
    source: "http" | "sqs",
  ): void {
    if (isMessageAlreadyProcessed(outcome)) {
      this.metrics.duplicateDetected("inbox_message", source);
      this.logger.log({ event: "wager.message_already_processed", kind: command.kind });
      return;
    }

    enrichContext({ transactionId: outcome.transactionId });

    if (outcome.idempotentReplay) {
      this.metrics.duplicateDetected("idempotent_replay", source);
    } else {
      this.metrics.transactionRecorded(command.kind, outcome.status);
    }

    this.logger.log({
      event: outcome.idempotentReplay ? "wager.replay" : "wager.processed",
      kind: command.kind,
      status: outcome.status,
      ...(outcome.failureCode && { failureCode: outcome.failureCode }),
      source,
    });
  }

  private async retryAfterDuplicate(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
    inbox: InboxContext | undefined,
  ): Promise<ProcessWagerTransactionResult | MessageAlreadyProcessed> {
    try {
      return await this.attempt(command, payloadHash, inbox);
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
    inbox: InboxContext | undefined,
  ): Promise<ProcessWagerTransactionResult | MessageAlreadyProcessed> {
    const at = this.clock.now();

    return this.unitOfWork.run(async (repositories) => {
      const received = inbox
        ? await this.receive(repositories.inbox, command, inbox, at)
        : undefined;

      if (received === "duplicate") {
        return { messageAlreadyProcessed: true };
      }

      const result = await this.process(repositories, command, payloadHash, at);

      if (received) {
        received.markProcessed(at);
        await repositories.inbox.markProcessed(received);
      }

      return result;
    });
  }

  private async receive(
    inboxRepository: InboxRepository,
    command: ProcessWagerTransactionCommand,
    inbox: InboxContext,
    at: Date,
  ): Promise<InboxMessage | "duplicate"> {
    const message = InboxMessage.receive({
      messageId: inbox.messageId,
      consumerName: inbox.consumerName,
      payloadHash: computeInboxPayloadHash(command),
      receivedAt: at,
    });

    const receipt = await inboxRepository.tryReceive(message);

    if (receipt.isNew) {
      return message;
    }

    if (!message.matchesPayload(receipt.storedPayloadHash)) {
      throw new InboxPayloadMismatchError(inbox.consumerName, inbox.messageId);
    }

    return "duplicate";
  }

  private async process(
    repositories: Repositories,
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
    at: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const wallet = await measureLockWait(this.metrics, () =>
      repositories.wallets.findByIdForUpdate(command.walletId),
    );

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
