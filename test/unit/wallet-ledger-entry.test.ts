import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import { InvalidLedgerEntryError } from "../../src/modules/wallet/domain/wallet-errors";
import {
  type CreateLedgerEntryProps,
  WalletLedgerEntry,
} from "../../src/modules/wallet/domain/wallet-ledger-entry";
import { DomainError } from "../../src/shared/domain/domain-error";
import { AT, brl, usd } from "../support/wagering-builders";

function entryProps(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
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
  };
}

describe("WalletLedgerEntry.create", () => {
  test("cria um débito balanceado", () => {
    const entry = WalletLedgerEntry.create(entryProps());

    expect(entry.id).toBe("entry-1");
    expect(entry.walletId).toBe("wallet-1");
    expect(entry.transactionId).toBe("tx-1");
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toJSON().amount).toBe("80.00");
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("20.00");
    expect(entry.walletVersion).toBe(2);
    expect(entry.createdAt).toBe(AT);
    expect(entry.isBalanced()).toBe(true);
  });

  test("cria um crédito balanceado", () => {
    const entry = WalletLedgerEntry.create(
      entryProps({
        direction: LedgerDirection.Credit,
        money: brl("25.00"),
        balanceBefore: brl("20.00"),
        balanceAfter: brl("45.00"),
      }),
    );

    expect(entry.isBalanced()).toBe(true);
  });

  test("aceita saldo anterior zero (lançamento de abertura) e saldo posterior zero", () => {
    const opening = WalletLedgerEntry.create(
      entryProps({
        direction: LedgerDirection.Credit,
        money: brl("1000.00"),
        balanceBefore: brl("0.00"),
        balanceAfter: brl("1000.00"),
        walletVersion: 1,
      }),
    );
    const drain = WalletLedgerEntry.create(
      entryProps({ money: brl("100.00"), balanceBefore: brl("100.00"), balanceAfter: brl("0.00") }),
    );

    expect(opening.isBalanced()).toBe(true);
    expect(drain.isBalanced()).toBe(true);
  });

  test.each([
    ["débito com saldo posterior errado", { balanceAfter: brl("21.00") }],
    ["débito que soma em vez de subtrair", { balanceAfter: brl("180.00") }],
    [
      "crédito que subtrai em vez de somar",
      { direction: LedgerDirection.Credit, balanceAfter: brl("20.00") },
    ],
    [
      "crédito com saldo posterior errado",
      { direction: LedgerDirection.Credit, balanceAfter: brl("181.00") },
    ],
  ])("rejeita aritmética que não confere: %s", (_name, overrides) => {
    expect(() => WalletLedgerEntry.create(entryProps(overrides))).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita valor zero", () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({ money: brl("0.00"), balanceBefore: brl("10.00"), balanceAfter: brl("10.00") }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita valor negativo", () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({
          direction: LedgerDirection.Credit,
          money: brl("10.00").negate(),
          balanceBefore: brl("20.00"),
          balanceAfter: brl("10.00"),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita saldo anterior ou posterior negativo", () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({
          money: brl("120.00"),
          balanceBefore: brl("100.00"),
          balanceAfter: brl("20.00").negate(),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({
          direction: LedgerDirection.Credit,
          money: brl("30.00"),
          balanceBefore: brl("10.00").negate(),
          balanceAfter: brl("20.00"),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita moedas diferentes entre valor e saldos", () => {
    expect(() => WalletLedgerEntry.create(entryProps({ money: usd("80.00") }))).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create(entryProps({ balanceAfter: usd("20.00") }))).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create(entryProps({ balanceBefore: usd("100.00") }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test.each([[0], [-1], [1.5], [Number.NaN]])("rejeita walletVersion %p", (walletVersion) => {
    expect(() => WalletLedgerEntry.create(entryProps({ walletVersion }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test("o erro é de domínio e tem código estável", () => {
    try {
      WalletLedgerEntry.create(entryProps({ balanceAfter: brl("21.00") }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as InvalidLedgerEntryError).code).toBe("LEDGER_ENTRY_INVALID");
    }
  });
});

describe("WalletLedgerEntry.rehydrate", () => {
  test("reconstrói o estado sem revalidar", () => {
    const entry = WalletLedgerEntry.rehydrate(entryProps({ balanceAfter: brl("21.00") }));

    expect(entry.balanceAfter.toJSON().amount).toBe("21.00");
    expect(entry.isBalanced()).toBe(false);
  });

  test("isBalanced é falso para moedas diferentes em vez de lançar", () => {
    const entry = WalletLedgerEntry.rehydrate(entryProps({ balanceAfter: usd("20.00") }));

    expect(entry.isBalanced()).toBe(false);
  });

  test("isBalanced não estoura nos limites do Money", () => {
    const max = brl("999999999999999999.99");
    const entry = WalletLedgerEntry.rehydrate(
      entryProps({
        direction: LedgerDirection.Credit,
        money: brl("1.00"),
        balanceBefore: max,
        balanceAfter: max,
      }),
    );

    expect(entry.isBalanced()).toBe(false);
  });
});

describe("WalletLedgerEntry: imutabilidade estrutural", () => {
  test("a instância é congelada e nenhum campo pode ser trocado", () => {
    const entry = WalletLedgerEntry.create(entryProps());
    const tampered = entry as unknown as Record<string, unknown>;

    expect(Object.isFrozen(entry)).toBe(true);
    for (const field of ["id", "direction", "money", "balanceAfter", "walletVersion"]) {
      expect(() => {
        tampered[field] = "outro";
      }).toThrow(TypeError);
    }
    expect(entry.balanceAfter.toJSON().amount).toBe("20.00");
  });

  test("não expõe métodos de transição nem de alteração", () => {
    const entry = WalletLedgerEntry.create(entryProps());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter(
      (name) => name !== "constructor",
    );

    expect(methods).toEqual(["isBalanced"]);
  });
});
