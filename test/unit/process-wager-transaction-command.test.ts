import { describe, expect, test } from "bun:test";
import { parseProcessWagerTransactionCommand } from "../../src/modules/wagering/application/process-wager-transaction.command";
import { WagerTransactionKind } from "../../src/modules/wagering/domain/wager-transaction";
import { InvalidRequestError } from "../../src/shared/application/invalid-request-error";
import { InvalidMoneyError, MoneyOutOfRangeError } from "../../src/shared/domain/money";

const WALLET_ID = "0192f291-27dd-7d3f-8071-5f8685deef37";

const valid = (): Record<string, unknown> => ({
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "player-1",
  walletId: WALLET_ID,
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
});

const parseWithKey = (idempotencyKey: unknown, overrides: Record<string, unknown> = {}) =>
  parseProcessWagerTransactionCommand({ idempotencyKey, payload: { ...valid(), ...overrides } });

const parse = (overrides: Record<string, unknown> = {}) => parseWithKey("key-1", overrides);

const without = (field: string) => {
  const payload = valid();
  delete payload[field];
  return parseProcessWagerTransactionCommand({ idempotencyKey: "key-1", payload });
};

describe("parseProcessWagerTransactionCommand: caminho feliz", () => {
  test("converte o payload em um comando tipado, com Money", () => {
    const command = parse();

    expect(command).toMatchObject({
      idempotencyKey: "key-1",
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      playerId: "player-1",
      walletId: WALLET_ID,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
    });
    expect(command.money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect("referenceExternalTransactionId" in command).toBe(false);
  });

  test("aceita BET, WIN e LOSS, REFUND e ROLLBACK (com referência)", () => {
    for (const kind of ["BET", "WIN", "LOSS"]) {
      expect(parse({ kind }).kind).toBe(kind as WagerTransactionKind);
    }
    for (const kind of ["REFUND", "ROLLBACK"]) {
      const command = parse({ kind, referenceExternalTransactionId: "bet-1" });
      expect(command.kind).toBe(kind as WagerTransactionKind);
      expect(command.referenceExternalTransactionId).toBe("bet-1");
    }
  });

  test("WIN e LOSS aceitam referência opcional; null conta como ausente", () => {
    expect(parse({ kind: "WIN", referenceExternalTransactionId: "bet-1" })).toMatchObject({
      referenceExternalTransactionId: "bet-1",
    });
    expect(
      "referenceExternalTransactionId" in
        parse({ kind: "LOSS", referenceExternalTransactionId: null }),
    ).toBe(false);
  });

  test("normaliza o valor com zeros à esquerda e aceita o limite máximo", () => {
    expect(parse({ money: { amount: "007.50", currency: "BRL" } }).money.toJSON().amount).toBe(
      "7.50",
    );
    expect(
      parse({ money: { amount: "999999999999999999.99", currency: "BRL" } }).money.toJSON().amount,
    ).toBe("999999999999999999.99");
  });

  test("ignora campos desconhecidos e não altera os textos recebidos", () => {
    const command = parse({ extra: "x", providerId: " provider-a " });

    expect(command.providerId).toBe(" provider-a ");
  });
});

describe("parseProcessWagerTransactionCommand: Idempotency-Key (P10)", () => {
  test("ausente, vazia, em branco ou de outro tipo é recusada", () => {
    for (const key of [undefined, null, "", "   ", 42, {}, ["a"]]) {
      expect(() => parseWithKey(key)).toThrow(InvalidRequestError);
      expect(() => parseWithKey(key)).toThrow(/Idempotency-Key/);
    }
  });

  test("aceita até 255 caracteres e recusa mais que isso", () => {
    expect(parseWithKey("k".repeat(255)).idempotencyKey).toHaveLength(255);
    expect(() => parseWithKey("k".repeat(256))).toThrow(/Idempotency-Key/);
  });
});

describe("parseProcessWagerTransactionCommand: campos obrigatórios", () => {
  const textFields = [
    "providerId",
    "externalTransactionId",
    "playerId",
    "walletId",
    "roundId",
    "gameId",
  ];

  for (const field of textFields) {
    test(`${field}: ausente, vazio, em branco, de outro tipo ou longo demais é recusado`, () => {
      expect(() => without(field)).toThrow(new RegExp(field));

      for (const value of [null, "", "   ", 7, {}, ["x"], "x".repeat(256)]) {
        expect(() => parse({ [field]: value })).toThrow(InvalidRequestError);
      }
    });
  }

  test("walletId precisa ser um UUID", () => {
    for (const walletId of ["abc", "123", `${WALLET_ID}0`, "nao-e-uuid"]) {
      expect(() => parse({ walletId })).toThrow(/walletId deve ser um UUID/);
    }
  });

  test("o corpo precisa ser um objeto JSON", () => {
    for (const payload of [undefined, null, "texto", 42, true, [], [valid()]]) {
      expect(() => parseProcessWagerTransactionCommand({ idempotencyKey: "k", payload })).toThrow(
        InvalidRequestError,
      );
    }
  });
});

describe("parseProcessWagerTransactionCommand: kind", () => {
  test("ausente, desconhecido, em minúsculas ou de outro tipo é recusado", () => {
    expect(() => without("kind")).toThrow(/kind/);

    for (const kind of [null, "", "bet", "Bet", "DEPOSIT", 1, {}]) {
      expect(() => parse({ kind })).toThrow(InvalidRequestError);
    }
  });

  test("OPENING nunca é aceito pela API", () => {
    expect(() => parse({ kind: "OPENING" })).toThrow(/OPENING é interno/);
  });
});

describe("parseProcessWagerTransactionCommand: money (D5)", () => {
  test("ausente ou que não é objeto é recusado", () => {
    for (const money of [undefined, null, "25.00", 25, [], true]) {
      expect(() => parse({ money })).toThrow(InvalidRequestError);
    }
  });

  test("valor zero é recusado", () => {
    expect(() => parse({ money: { amount: "0.00", currency: "BRL" } })).toThrow(InvalidMoneyError);
    expect(() => parse({ money: { amount: "000.00", currency: "BRL" } })).toThrow(/maior que zero/);
  });

  test("negativo, escala errada, notação científica e tipos errados viram InvalidMoneyError", () => {
    const amounts: unknown[] = [
      "-1.00",
      "1.0",
      "1",
      "1.005",
      "1e3",
      "",
      "abc",
      " 1.00",
      25,
      null,
      undefined,
    ];

    for (const amount of amounts) {
      expect(() => parse({ money: { amount, currency: "BRL" } })).toThrow(InvalidMoneyError);
    }
  });

  test("moeda inválida vira InvalidMoneyError", () => {
    for (const currency of ["brl", "BR", "BRLL", "", 1, null, undefined]) {
      expect(() => parse({ money: { amount: "1.00", currency } })).toThrow(InvalidMoneyError);
    }
  });

  test("acima do limite vira MoneyOutOfRangeError", () => {
    expect(() => parse({ money: { amount: "1000000000000000000.00", currency: "BRL" } })).toThrow(
      MoneyOutOfRangeError,
    );
  });
});

describe("parseProcessWagerTransactionCommand: referência", () => {
  test("REFUND e ROLLBACK exigem referenceExternalTransactionId", () => {
    for (const kind of ["REFUND", "ROLLBACK"]) {
      expect(() => parse({ kind })).toThrow(/exige referenceExternalTransactionId/);
      expect(() => parse({ kind, referenceExternalTransactionId: null })).toThrow(
        InvalidRequestError,
      );
    }
  });

  test("BET não aceita referência", () => {
    expect(() => parse({ kind: "BET", referenceExternalTransactionId: "x" })).toThrow(
      /BET não aceita/,
    );
  });

  test("referência presente precisa ser texto não vazio", () => {
    for (const value of ["", "  ", 7, {}]) {
      expect(() => parse({ kind: "WIN", referenceExternalTransactionId: value })).toThrow(
        InvalidRequestError,
      );
    }
  });
});
