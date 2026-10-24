import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/modules/wagering/domain/failure-code";

describe("FailureCode: taxonomia do plano (seção 3.2)", () => {
  test("contém exatamente os códigos documentados, com valores estáveis", () => {
    expect(Object.values<string>(FailureCode).sort()).toEqual(
      [
        "INSUFFICIENT_FUNDS",
        "REVERSAL_INSUFFICIENT_FUNDS",
        "CURRENCY_MISMATCH",
        "WALLET_PLAYER_MISMATCH",
        "REFERENCE_NOT_FOUND",
        "REFERENCE_KIND_NOT_ALLOWED",
        "REFERENCE_ROUND_MISMATCH",
        "REFERENCE_WALLET_MISMATCH",
        "REFERENCE_PLAYER_MISMATCH",
        "REFERENCE_CURRENCY_MISMATCH",
        "REFERENCE_AMOUNT_MISMATCH",
        "REFERENCE_ALREADY_REVERSED",
        "REFERENCE_NOT_PROCESSED",
        "PROCESSING_FAILED",
      ].sort(),
    );
  });

  test("o código de saldo insuficiente em aposta é distinto do de reversão (regra 9)", () => {
    expect(FailureCode.InsufficientFunds).not.toBe(FailureCode.ReversalInsufficientFunds);
  });

  test("todos os códigos são legíveis por máquina (MAIUSCULAS_COM_UNDERLINE) e únicos", () => {
    const values = Object.values(FailureCode);

    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
    }
  });
});
