import { randomUUID } from "node:crypto";
import { InboxMessage } from "../../src/modules/messaging/domain/inbox-message";
import { OutboxMessage } from "../../src/modules/messaging/domain/outbox-message";
import { WagerTransactionProcessed } from "../../src/modules/wagering/domain/events/wager-transaction-processed";
import {
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/wager-transaction";
import { WalletBalanceChanged } from "../../src/modules/wallet/domain/events/wallet-balance-changed";
import { Wallet } from "../../src/modules/wallet/domain/wallet";
import type { WalletLedgerEntry } from "../../src/modules/wallet/domain/wallet-ledger-entry";
import type { Money } from "../../src/shared/domain/money";
import { AT, aContext, brl } from "./wagering-builders";

export function aNewWallet(overrides: { balance?: Money; playerId?: string } = {}): Wallet {
  return Wallet.open({
    id: randomUUID(),
    playerId: overrides.playerId ?? `player-${randomUUID()}`,
    initialBalance: overrides.balance ?? brl("100.00"),
    openingTransactionId: randomUUID(),
    openingEntryId: randomUUID(),
    at: AT,
  }).wallet;
}

export function aNewTransaction(
  walletId: string,
  overrides: Partial<WagerTransactionState> = {},
): WagerTransaction {
  const unique = randomUUID();

  return WagerTransaction.rehydrate({
    id: randomUUID(),
    providerId: "provider-a",
    externalTransactionId: `ext-${unique}`,
    idempotencyKey: `key-${unique}`,
    payloadHash: `hash-${unique}`,
    walletId,
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: brl("25.00"),
    createdAt: AT,
    status: WagerTransactionStatus.Pending,
    ...overrides,
  });
}

export const LATER = new Date("2026-01-01T12:30:00.000Z");

export function debitFor(
  wallet: Wallet,
  transaction: WagerTransaction,
  at: Date = AT,
): WalletLedgerEntry {
  return wallet.debit({
    entryId: randomUUID(),
    transactionId: transaction.id,
    money: transaction.money,
    at,
  });
}

export function anInboxMessage(overrides: { messageId?: string; payloadHash?: string } = {}) {
  return InboxMessage.receive({
    consumerName: "wager-transactions",
    messageId: overrides.messageId ?? `msg-${randomUUID()}`,
    payloadHash: overrides.payloadHash ?? "hash-a",
    receivedAt: AT,
  });
}

export function anOutboxMessage(entry: WalletLedgerEntry): OutboxMessage {
  return OutboxMessage.enqueue(
    WalletBalanceChanged.from(entry, aContext({ eventId: randomUUID() })),
  );
}

export function aProcessedOutboxMessage(transaction: WagerTransaction): OutboxMessage {
  return OutboxMessage.enqueue(
    WagerTransactionProcessed.from(transaction, aContext({ eventId: randomUUID() })),
  );
}
