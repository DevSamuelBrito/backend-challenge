import { describe, expect, test } from "bun:test";
import { parseOpenWalletRequest } from "../../src/modules/wallet/http/open-wallet.request";
import { InvalidMoneyError, MoneyOutOfRangeError } from "../../src/shared/domain/money";
import { InvalidRequestError } from "../../src/shared/infrastructure/http/invalid-request-error";
import { parseUuid } from "../../src/shared/infrastructure/http/parse-uuid";

const valid = (overrides: Record<string, unknown> = {}) => ({
  playerId: "player-1",
  initialBalance: { amount: "100.00", currency: "BRL" },
  ...overrides,
});

describe("parseOpenWalletRequest", () => {
  test("converte um corpo válido em comando com Money", () => {
    const command = parseOpenWalletRequest(valid());

    expect(command.playerId).toBe("player-1");
    expect(command.initialBalance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
  });

  test("aceita saldo inicial zero", () => {
    expect(
      parseOpenWalletRequest(
        valid({ initialBalance: { amount: "0.00", currency: "USD" } }),
      ).initialBalance.isZero(),
    ).toBe(true);
  });

  test("aceita o limite máximo exato", () => {
    const command = parseOpenWalletRequest(
      valid({ initialBalance: { amount: "999999999999999999.99", currency: "BRL" } }),
    );

    expect(command.initialBalance.toJSON().amount).toBe("999999999999999999.99");
  });

  test("não altera o playerId (sem trim)", () => {
    expect(parseOpenWalletRequest(valid({ playerId: " player-1 " })).playerId).toBe(" player-1 ");
  });

  test("corpo que não é objeto é recusado", () => {
    for (const body of [undefined, null, "texto", 42, true, [], [valid()]]) {
      expect(() => parseOpenWalletRequest(body)).toThrow(InvalidRequestError);
    }
  });

  test("playerId ausente, vazio, em branco ou de outro tipo é recusado", () => {
    for (const playerId of [undefined, null, "", "   ", 7, {}, ["a"]]) {
      expect(() => parseOpenWalletRequest(valid({ playerId }))).toThrow(/playerId/);
    }
  });

  test("initialBalance ausente ou que não é objeto é recusado", () => {
    for (const initialBalance of [undefined, null, "100.00", 100, [], true]) {
      expect(() => parseOpenWalletRequest(valid({ initialBalance }))).toThrow(InvalidRequestError);
    }
  });

  test("amount inválido vira InvalidMoneyError", () => {
    const amounts: unknown[] = [
      "-5.00",
      "1.0",
      "1.555",
      "1e3",
      "",
      "abc",
      "10",
      ".50",
      "+1.00",
      " 1.00",
      100,
      null,
      undefined,
    ];

    for (const amount of amounts) {
      expect(() =>
        parseOpenWalletRequest(valid({ initialBalance: { amount, currency: "BRL" } })),
      ).toThrow(InvalidMoneyError);
    }
  });

  test("moeda inválida vira InvalidMoneyError", () => {
    for (const currency of ["brl", "BR", "BRLX", "", "R$", 1, null, undefined]) {
      expect(() =>
        parseOpenWalletRequest(valid({ initialBalance: { amount: "1.00", currency } })),
      ).toThrow(InvalidMoneyError);
    }
  });

  test("valor acima do limite vira MoneyOutOfRangeError", () => {
    expect(() =>
      parseOpenWalletRequest(
        valid({ initialBalance: { amount: "1000000000000000000.00", currency: "BRL" } }),
      ),
    ).toThrow(MoneyOutOfRangeError);
  });
});

describe("parseUuid", () => {
  test("aceita UUIDs no formato canônico, de qualquer versão", () => {
    for (const id of [
      "0192f5b0-7c1e-7a2b-8f3d-123456789abc",
      "123e4567-e89b-12d3-a456-426614174000",
      "123E4567-E89B-12D3-A456-426614174000",
    ]) {
      expect(parseUuid(id, "walletId")).toBe(id);
    }
  });

  test("recusa o que não é UUID, citando o campo", () => {
    for (const id of [
      "",
      "abc",
      "123",
      "123e4567e89b12d3a456426614174000",
      "{123e4567-e89b-12d3-a456-426614174000}",
      "123e4567-e89b-12d3-a456-42661417400g",
      "123e4567-e89b-12d3-a456-4266141740000",
    ]) {
      expect(() => parseUuid(id, "walletId")).toThrow(InvalidRequestError);
      expect(() => parseUuid(id, "walletId")).toThrow(/walletId/);
    }
  });
});
