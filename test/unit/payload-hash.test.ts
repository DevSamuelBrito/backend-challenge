import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { computePayloadHash } from "../../src/modules/wagering/application/payload-hash";
import {
  type ProcessWagerTransactionCommand,
  parseProcessWagerTransactionCommand,
} from "../../src/modules/wagering/application/process-wager-transaction.command";
import { canonicalJson } from "../../src/shared/application/canonical-json";

const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";

const payload = (overrides: Record<string, unknown> = {}) => ({
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "player-1",
  walletId: WALLET_ID,
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
  ...overrides,
});

const command = (
  overrides: Record<string, unknown> = {},
  idempotencyKey = "provider-a:transaction-123",
): ProcessWagerTransactionCommand =>
  parseProcessWagerTransactionCommand({ idempotencyKey, payload: payload(overrides) });

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("canonicalJson", () => {
  test("ordena as chaves, em qualquer nível, e não usa espaços", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  test("a ordem de inserção das chaves não muda o resultado", () => {
    expect(canonicalJson({ x: 1, y: 2, z: 3 })).toBe(canonicalJson({ z: 3, x: 1, y: 2 }));
  });

  test("descarta propriedades undefined, mas mantém null e a ordem dos arrays", () => {
    expect(canonicalJson({ a: undefined, b: null, c: [2, 1] })).toBe('{"b":null,"c":[2,1]}');
  });

  test("serializa textos com escape, como o JSON", () => {
    expect(canonicalJson({ a: 'aspas " e \\ barra' })).toBe('{"a":"aspas \\" e \\\\ barra"}');
  });
});

describe("computePayloadHash", () => {
  test("é o SHA-256 hex do JSON canônico dos campos de negócio (algoritmo documentado)", () => {
    const expected = sha256(
      `{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a","roundId":"round-987","walletId":"${WALLET_ID}"}`,
    );

    expect(computePayloadHash(command())).toBe(expected);
    expect(computePayloadHash(command())).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a ordem das chaves do payload recebido é irrelevante", () => {
    const reordered = parseProcessWagerTransactionCommand({
      idempotencyKey: "provider-a:transaction-123",
      payload: {
        money: { currency: "BRL", amount: "25.00" },
        kind: "BET",
        walletId: WALLET_ID,
        gameId: "fortune-chimp",
        roundId: "round-987",
        playerId: "player-1",
        externalTransactionId: "transaction-123",
        providerId: "provider-a",
      },
    });

    expect(computePayloadHash(reordered)).toBe(computePayloadHash(command()));
  });

  test("usa o valor normalizado: 007.50 e 7.50 geram o mesmo hash", () => {
    const padded = command({ money: { amount: "007.50", currency: "BRL" } });
    const plain = command({ money: { amount: "7.50", currency: "BRL" } });

    expect(computePayloadHash(padded)).toBe(computePayloadHash(plain));
  });

  test("a Idempotency-Key não entra no hash", () => {
    expect(computePayloadHash(command({}, "chave-a"))).toBe(
      computePayloadHash(command({}, "chave-completamente-diferente")),
    );
  });

  test("campos extras do payload não entram no hash", () => {
    expect(computePayloadHash(command({ metadata: "x", traceId: "y" }))).toBe(
      computePayloadHash(command()),
    );
  });

  test("a referência só entra quando existe: ausente, null e omitida dão o mesmo hash", () => {
    const base = computePayloadHash(command({ kind: "WIN" }));

    expect(computePayloadHash(command({ kind: "WIN", referenceExternalTransactionId: null }))).toBe(
      base,
    );
    expect(computePayloadHash(command({ kind: "WIN" }))).toBe(base);
  });

  test("com referência, ela entra no hash, e referências diferentes dão hashes diferentes", () => {
    const withBet1 = command({ kind: "WIN", referenceExternalTransactionId: "bet-1" });
    const withBet2 = command({ kind: "WIN", referenceExternalTransactionId: "bet-2" });

    expect(computePayloadHash(withBet1)).not.toBe(computePayloadHash(command({ kind: "WIN" })));
    expect(computePayloadHash(withBet1)).not.toBe(computePayloadHash(withBet2));
    expect(computePayloadHash(withBet1)).toBe(
      sha256(
        `{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"WIN","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-a","referenceExternalTransactionId":"bet-1","roundId":"round-987","walletId":"${WALLET_ID}"}`,
      ),
    );
  });

  test("qualquer campo de negócio diferente muda o hash", () => {
    const base = computePayloadHash(command());
    const variations: Record<string, unknown>[] = [
      { providerId: "provider-b" },
      { externalTransactionId: "transaction-124" },
      { playerId: "player-2" },
      { walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" },
      { roundId: "round-988" },
      { gameId: "other-game" },
      { kind: "WIN" },
      { kind: "LOSS" },
      { money: { amount: "25.01", currency: "BRL" } },
      { money: { amount: "25.00", currency: "USD" } },
    ];

    const hashes = variations.map((variation) => computePayloadHash(command(variation)));

    for (const hash of hashes) {
      expect(hash).not.toBe(base);
    }
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test("valores que diferem só no zero à esquerda do centavo são diferentes (7.50 ≠ 7.05)", () => {
    expect(computePayloadHash(command({ money: { amount: "7.50", currency: "BRL" } }))).not.toBe(
      computePayloadHash(command({ money: { amount: "7.05", currency: "BRL" } })),
    );
  });
});
