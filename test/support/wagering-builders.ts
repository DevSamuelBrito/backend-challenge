import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import {
  type LedgerEntryState,
  WalletLedgerEntry,
} from "../../src/modules/wallet/domain/wallet-ledger-entry";
import { Money } from "../../src/shared/domain/money";
import type { EventContext } from "../../src/shared/events/integration-event";

export const AT = new Date("2026-01-01T12:00:00.000Z");

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string) => Money.from({ amount, currency: "USD" });

export function createProps(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
    id: "tx-1",
    providerId: "provider-a",
    externalTransactionId: "ext-1",
    idempotencyKey: "provider-a:ext-1",
    payloadHash: "hash-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: brl("25.00"),
    createdAt: AT,
    ...overrides,
  };
}

export function aTransaction(overrides: Partial<WagerTransactionState> = {}): WagerTransaction {
  return WagerTransaction.rehydrate({
    ...createProps(),
    status: WagerTransactionStatus.Pending,
    ...overrides,
  });
}

export function aProcessed(overrides: Partial<WagerTransactionState> = {}): WagerTransaction {
  return aTransaction({
    status: WagerTransactionStatus.Processed,
    balanceAfter: brl("100.00"),
    processedAt: AT,
    ...overrides,
  });
}

export function aLedgerEntry(overrides: Partial<LedgerEntryState> = {}): WalletLedgerEntry {
  return WalletLedgerEntry.create({
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "tx-1",
    direction: LedgerDirection.Debit,
    money: brl("80.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("20.00"),
    walletVersion: 2,
    createdAt: AT,
    ...overrides,
  });
}

export function aContext(overrides: Partial<EventContext> = {}): EventContext {
  return {
    eventId: "evt-1",
    correlationId: "corr-1",
    causationId: "cause-1",
    occurredAt: AT,
    ...overrides,
  };
}
