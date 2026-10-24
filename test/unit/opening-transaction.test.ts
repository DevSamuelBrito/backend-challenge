import { describe, expect, test } from "bun:test";
import { WagerTransactionProcessed } from "../../src/modules/wagering/domain/events/wager-transaction-processed";
import {
  OPENING_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/wager-transaction";
import { InvalidWagerTransactionError } from "../../src/modules/wagering/domain/wager-transaction-errors";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import { AT, aContext, brl, usd } from "../support/wagering-builders";

const opening = (overrides: Partial<Parameters<typeof WagerTransaction.createOpening>[0]> = {}) =>
  WagerTransaction.createOpening({
    id: "tx-opening",
    walletId: "wallet-1",
    playerId: "player-1",
    money: brl("250.00"),
    createdAt: AT,
    ...overrides,
  });

describe("WagerTransaction.createOpening (P6)", () => {
  test("preenche os campos fixos da premissa P6", () => {
    const transaction = opening();

    expect(transaction.providerId).toBe("internal");
    expect(transaction.providerId).toBe(OPENING_PROVIDER_ID);
    expect(transaction.externalTransactionId).toBe("wallet-1");
    expect(transaction.idempotencyKey).toBe("opening:wallet-1");
    expect(transaction.roundId).toBe("opening");
    expect(transaction.gameId).toBe("opening");
    expect(transaction.kind).toBe(WagerTransactionKind.Opening);
    expect(transaction.walletId).toBe("wallet-1");
    expect(transaction.playerId).toBe("player-1");
    expect(transaction.createdAt).toBe(AT);
  });

  test("já nasce PROCESSED, terminal, com o saldo resultante igual ao valor da abertura", () => {
    const transaction = opening({ money: usd("80.00") });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.money.toJSON()).toEqual({ amount: "80.00", currency: "USD" });
    expect(transaction.balanceAfter?.toJSON()).toEqual({ amount: "80.00", currency: "USD" });
    expect(transaction.processedAt).toBe(AT);
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.referenceExternalTransactionId).toBeUndefined();
  });

  test("afeta saldo, é um CREDIT e não exige referência", () => {
    const transaction = opening();

    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.requiresReference()).toBe(false);
    expect(transaction.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("o payloadHash é um SHA-256 hex determinístico", () => {
    const first = opening();
    const again = opening();

    expect(first.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(again.payloadHash).toBe(first.payloadHash);
    expect(first.matchesPayload(again.payloadHash)).toBe(true);
  });

  test("o payloadHash muda quando muda a wallet, o jogador, o valor ou a moeda", () => {
    const base = opening().payloadHash;

    expect(opening({ walletId: "wallet-2" }).payloadHash).not.toBe(base);
    expect(opening({ playerId: "player-2" }).payloadHash).not.toBe(base);
    expect(opening({ money: brl("250.01") }).payloadHash).not.toBe(base);
    expect(opening({ money: usd("250.00") }).payloadHash).not.toBe(base);
  });

  test("o payloadHash não depende do id da transação nem da hora", () => {
    const other = opening({ id: "outro-id", createdAt: new Date("2030-01-01T00:00:00.000Z") });

    expect(other.payloadHash).toBe(opening().payloadHash);
  });

  test("recusa valor zero: sem saldo inicial não existe transação OPENING", () => {
    expect(() => opening({ money: brl("0.00") })).toThrow(InvalidWagerTransactionError);
  });

  test("permite emitir o evento WagerTransactionProcessed a partir dela", () => {
    const event = WagerTransactionProcessed.from(opening(), aContext());

    expect(event.aggregateId).toBe("tx-opening");
    expect(event.data.kind).toBe(WagerTransactionKind.Opening);
    expect(event.data.balanceAfter).toEqual({ amount: "250.00", currency: "BRL" });
  });
});
