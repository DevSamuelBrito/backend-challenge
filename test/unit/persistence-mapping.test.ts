import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import { walletMapper } from "../../src/modules/wallet/infrastructure/wallet.mapper";
import { InvalidMoneyError } from "../../src/shared/domain/money";
import {
  CorruptedRecordError,
  moneyFromColumn,
  moneyToColumn,
  parseEnum,
} from "../../src/shared/infrastructure/database/mapping";
import { aNewWallet } from "../support/persistence-builders";
import { brl } from "../support/wagering-builders";

describe("mapeamento: dinheiro entre coluna e domínio", () => {
  test("string numeric vira Money e volta idêntica", () => {
    const money = moneyFromColumn("9007199254740993.01", "BRL");

    expect(moneyToColumn(money)).toBe("9007199254740993.01");
    expect(money.currency).toBe("BRL");
  });

  test("um valor que chegasse como number do driver é recusado, nunca convertido", () => {
    expect(() => moneyFromColumn(1234.5 as unknown as string, "BRL")).toThrow(InvalidMoneyError);
    expect(() =>
      moneyFromColumn((Number.MAX_SAFE_INTEGER + 2) as unknown as string, "BRL"),
    ).toThrow(InvalidMoneyError);
  });

  test("a coluna do mapper da wallet é sempre string, mesmo para valores gigantes", () => {
    const record = walletMapper.toRecord(aNewWallet({ balance: brl("999999999999999999.99") }));

    expect(typeof record.balance).toBe("string");
    expect(record.balance).toBe("999999999999999999.99");
  });
});

describe("mapeamento: enums vindos do banco", () => {
  test("valor conhecido é aceito", () => {
    expect(parseEnum(LedgerDirection, "direction", "DEBIT")).toBe(LedgerDirection.Debit);
  });

  test("valor desconhecido lança CorruptedRecordError com a coluna", () => {
    expect(() => parseEnum(LedgerDirection, "wallet_ledger_entries.direction", "SIDEWAYS")).toThrow(
      CorruptedRecordError,
    );
    expect(() => parseEnum(LedgerDirection, "wallet_ledger_entries.direction", "SIDEWAYS")).toThrow(
      /wallet_ledger_entries\.direction/,
    );
  });
});
