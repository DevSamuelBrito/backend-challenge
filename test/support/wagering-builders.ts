import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/wager-transaction";
import { Money } from "../../src/shared/domain/money";

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
