import { Inject, Injectable } from "@nestjs/common";
import { ID_GENERATOR, type IdGenerator } from "../../../shared/application/id-generator.port";
import type { Repositories } from "../../../shared/application/unit-of-work.port";
import type { EventContext, IntegrationEvent } from "../../../shared/events/integration-event";
import type { OutboxRepository } from "../../messaging/application/outbox.repository";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { WalletBalanceChanged } from "../../wallet/domain/events/wallet-balance-changed";
import { LedgerDirection } from "../../wallet/domain/ledger-direction";
import type { Wallet } from "../../wallet/domain/wallet";
import { InsufficientFundsError } from "../../wallet/domain/wallet-errors";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import { WagerTransactionPendingReference } from "../domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected";
import { FailureCode } from "../domain/failure-code";
import { evaluateReference, type ReferenceLookup } from "../domain/reference-policy";
import { type WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";

export type Settlement =
  | { kind: "settled"; entry: WalletLedgerEntry | undefined }
  | { kind: "waiting"; referenceFound: boolean };

@Injectable()
export class WagerSettlement {
  constructor(@Inject(ID_GENERATOR) private readonly ids: IdGenerator) {}

  async settle(
    repositories: Repositories,
    wallet: Wallet,
    transaction: WagerTransaction,
    at: Date,
  ): Promise<Settlement> {
    const failure = this.preconditionFailure(wallet, transaction);

    if (failure) {
      transaction.reject(failure, wallet.balance, at);
      return { kind: "settled", entry: undefined };
    }

    const lookup = await this.lookupReference(repositories, transaction);
    const decision = evaluateReference(transaction, lookup);

    switch (decision.status) {
      case WagerTransactionStatus.Rejected:
        transaction.reject(decision.failureCode, wallet.balance, at);
        return { kind: "settled", entry: undefined };
      case WagerTransactionStatus.PendingReference:
        return { kind: "waiting", referenceFound: lookup.reference !== undefined };
      case WagerTransactionStatus.Processed:
        return {
          kind: "settled",
          entry: this.applyMovement(
            wallet,
            transaction,
            lookup.reference,
            decision.referenceTransactionId,
            at,
          ),
        };
    }
  }

  async persistMovement(
    { wallets, ledger }: Repositories,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
  ): Promise<void> {
    if (entry) {
      await ledger.append(entry);
      await wallets.save(wallet);
    }
  }

  async publishOutcome(
    outbox: OutboxRepository,
    transaction: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    at: Date,
  ): Promise<void> {
    const contextFor = this.contextFactory(transaction, at);

    if (transaction.status === WagerTransactionStatus.Processed) {
      await this.publish(outbox, WagerTransactionProcessed.from(transaction, contextFor()));
    }

    if (entry) {
      await this.publish(outbox, WalletBalanceChanged.from(entry, contextFor()));
    }

    if (transaction.status === WagerTransactionStatus.Rejected) {
      await this.publish(outbox, WagerTransactionRejected.from(transaction, contextFor()));
    }
  }

  async publishPendingReference(
    outbox: OutboxRepository,
    transaction: WagerTransaction,
    at: Date,
  ): Promise<void> {
    const contextFor = this.contextFactory(transaction, at);

    await this.publish(outbox, WagerTransactionPendingReference.from(transaction, contextFor()));
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
    referenceTransactionId: string | undefined,
    at: Date,
  ): WalletLedgerEntry | undefined {
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

  private contextFactory(transaction: WagerTransaction, at: Date): () => EventContext {
    const correlationId = this.ids.next();

    return () => ({
      eventId: this.ids.next(),
      correlationId,
      causationId: transaction.idempotencyKey,
      occurredAt: at,
    });
  }

  private publish(outbox: OutboxRepository, event: IntegrationEvent<unknown>): Promise<void> {
    return outbox.add(OutboxMessage.enqueue(event));
  }
}
