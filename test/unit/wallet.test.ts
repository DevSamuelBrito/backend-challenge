import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import { Wallet } from "../../src/modules/wallet/domain/wallet";
import {
  InsufficientFundsError,
  InvalidWalletError,
} from "../../src/modules/wallet/domain/wallet-errors";
import type { WalletLedgerEntry } from "../../src/modules/wallet/domain/wallet-ledger-entry";
import { DomainError } from "../../src/shared/domain/domain-error";
import { CurrencyMismatchError, Money, MoneyOutOfRangeError } from "../../src/shared/domain/money";
import { AT, brl, usd } from "../support/wagering-builders";

const LATER = new Date("2026-01-02T08:30:00.000Z");

function openWallet(initialBalance = "100.00"): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(initialBalance),
    at: AT,
  });
}

let sequence = 0;
function movement(amount: Money, at: Date = LATER) {
  sequence += 1;
  return { entryId: `entry-${sequence}`, transactionId: `tx-${sequence}`, money: amount, at };
}

describe("Wallet.open", () => {
  test("abre com o saldo inicial, a moeda do saldo e version 1", () => {
    const wallet = openWallet("1000.00");

    expect(wallet.id).toBe("wallet-1");
    expect(wallet.playerId).toBe("player-1");
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toBe(AT);
    expect(wallet.updatedAt).toBe(AT);
  });

  test("aceita saldo inicial zero", () => {
    const wallet = openWallet("0.00");

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test("é multi-moeda: a moeda vem do saldo inicial", () => {
    const wallet = Wallet.open({
      id: "wallet-2",
      playerId: "player-1",
      initialBalance: usd("5.00"),
      at: AT,
    });

    expect(wallet.currency).toBe("USD");
  });

  test("rejeita saldo inicial negativo", () => {
    const negative = brl("10.00").negate();

    expect(() => Wallet.open({ id: "w", playerId: "p", initialBalance: negative, at: AT })).toThrow(
      InvalidWalletError,
    );
  });
});

describe("Wallet.rehydrate", () => {
  test("reconstrói o estado exatamente como foi persistido", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-9",
      playerId: "player-9",
      currency: "BRL",
      balance: brl("42.50"),
      version: 7,
      createdAt: AT,
      updatedAt: LATER,
    });

    expect(wallet.id).toBe("wallet-9");
    expect(wallet.balance.toJSON().amount).toBe("42.50");
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toBe(AT);
    expect(wallet.updatedAt).toBe(LATER);
  });

  test("não revalida: aceita estado que open recusaria", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-9",
      playerId: "player-9",
      currency: "BRL",
      balance: brl("10.00").negate(),
      version: 0,
      createdAt: AT,
      updatedAt: AT,
    });

    expect(wallet.balance.isNegative()).toBe(true);
    expect(wallet.version).toBe(0);
  });

  test("uma wallet reidratada continua movimentando normalmente", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-9",
      playerId: "player-9",
      currency: "BRL",
      balance: brl("42.50"),
      version: 7,
      createdAt: AT,
      updatedAt: AT,
    });

    const entry = wallet.debit(movement(brl("2.50")));

    expect(wallet.balance.toJSON().amount).toBe("40.00");
    expect(wallet.version).toBe(8);
    expect(entry.walletVersion).toBe(8);
  });
});

describe("Wallet.debit", () => {
  test("diminui o saldo, incrementa a version e devolve o lançamento correspondente", () => {
    const wallet = openWallet();
    const input = movement(brl("80.00"));

    const entry = wallet.debit(input);

    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toBe(LATER);
    expect(entry.id).toBe(input.entryId);
    expect(entry.walletId).toBe("wallet-1");
    expect(entry.transactionId).toBe(input.transactionId);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toJSON().amount).toBe("80.00");
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("20.00");
    expect(entry.walletVersion).toBe(2);
    expect(entry.createdAt).toBe(LATER);
    expect(entry.isBalanced()).toBe(true);
  });

  test("permite zerar o saldo exatamente", () => {
    const wallet = openWallet("80.00");

    wallet.debit(movement(brl("80.00")));

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test("cenário do desafio: 100.00 com duas apostas de 80.00, só a primeira passa", () => {
    const wallet = openWallet("100.00");

    wallet.debit(movement(brl("80.00")));

    expect(() => wallet.debit(movement(brl("80.00")))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test("saldo insuficiente lança erro de domínio e não altera nada", () => {
    const wallet = openWallet("79.99");

    try {
      wallet.debit(movement(brl("80.00")));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as InsufficientFundsError).code).toBe("INSUFFICIENT_FUNDS");
    }

    expect(wallet.balance.toJSON().amount).toBe("79.99");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toBe(AT);
  });

  test("um centavo a mais que o saldo é insuficiente", () => {
    const wallet = openWallet("10.00");

    expect(() => wallet.debit(movement(brl("10.01")))).toThrow(InsufficientFundsError);
    expect(() => wallet.debit(movement(brl("10.00")))).not.toThrow();
  });

  test("rejeita moeda diferente da wallet sem alterar nada", () => {
    const wallet = openWallet();

    expect(() => wallet.debit(movement(usd("10.00")))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("rejeita valor zero e valor negativo", () => {
    const wallet = openWallet();

    expect(() => wallet.debit(movement(brl("0.00")))).toThrow(InvalidWalletError);
    expect(() => wallet.debit(movement(brl("5.00").negate()))).toThrow(InvalidWalletError);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet.credit", () => {
  test("aumenta o saldo, incrementa a version e devolve o lançamento correspondente", () => {
    const wallet = openWallet("20.00");
    const input = movement(brl("5.50"));

    const entry = wallet.credit(input);

    expect(wallet.balance.toJSON().amount).toBe("25.50");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toBe(LATER);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toJSON().amount).toBe("20.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("25.50");
    expect(entry.walletVersion).toBe(2);
    expect(entry.transactionId).toBe(input.transactionId);
    expect(entry.isBalanced()).toBe(true);
  });

  test("credita em wallet com saldo zero", () => {
    const wallet = openWallet("0.00");

    wallet.credit(movement(brl("0.01")));

    expect(wallet.balance.toJSON().amount).toBe("0.01");
    expect(wallet.version).toBe(2);
  });

  test("rejeita moeda diferente, valor zero e valor negativo sem alterar nada", () => {
    const wallet = openWallet();

    expect(() => wallet.credit(movement(usd("10.00")))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(movement(brl("0.00")))).toThrow(InvalidWalletError);
    expect(() => wallet.credit(movement(brl("5.00").negate()))).toThrow(InvalidWalletError);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("crédito que estoura o limite do Money falha sem alterar nada", () => {
    const wallet = openWallet("999999999999999999.99");

    expect(() => wallet.credit(movement(brl("0.01")))).toThrow(MoneyOutOfRangeError);
    expect(wallet.balance.toJSON().amount).toBe("999999999999999999.99");
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet: version e ledger", () => {
  test("a version só incrementa quando o saldo muda", () => {
    const wallet = openWallet();

    expect(() => wallet.debit(movement(brl("500.00")))).toThrow();
    expect(() => wallet.credit(movement(usd("1.00")))).toThrow();
    expect(() => wallet.credit(movement(brl("0.00")))).toThrow();
    expect(wallet.version).toBe(1);

    wallet.debit(movement(brl("10.00")));
    expect(wallet.version).toBe(2);
    wallet.credit(movement(brl("10.00")));
    expect(wallet.version).toBe(3);
    wallet.debit(movement(brl("1.00")));
    expect(wallet.version).toBe(4);
  });

  test("cada movimentação gera um lançamento encadeado ao anterior", () => {
    const wallet = openWallet("100.00");
    const entries: WalletLedgerEntry[] = [
      wallet.debit(movement(brl("30.00"))),
      wallet.credit(movement(brl("12.34"))),
      wallet.debit(movement(brl("0.34"))),
    ];

    expect(entries.map((entry) => entry.walletVersion)).toEqual([2, 3, 4]);
    expect(entries[1]?.balanceBefore.equals(entries[0]?.balanceAfter as Money)).toBe(true);
    expect(entries[2]?.balanceBefore.equals(entries[1]?.balanceAfter as Money)).toBe(true);
    expect(entries[2]?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toJSON().amount).toBe("82.00");
  });

  test("invariante: o saldo nunca fica negativo e bate com o extrato em 500 operações", () => {
    let seed = 20260101;
    const next = (limit: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % limit;
    };

    const wallet = openWallet("50.00");
    const entries: WalletLedgerEntry[] = [];
    let rejected = 0;

    for (let index = 0; index < 500; index++) {
      const amount = brl(`${next(40)}.${String(next(100)).padStart(2, "0")}`);
      if (amount.isZero()) continue;

      try {
        entries.push(
          next(2) === 0 ? wallet.debit(movement(amount)) : wallet.credit(movement(amount)),
        );
      } catch (error) {
        expect(error).toBeInstanceOf(InsufficientFundsError);
        rejected += 1;
      }

      expect(wallet.balance.isNegative()).toBe(false);
    }

    const rebuilt = entries.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Credit
          ? balance.add(entry.money)
          : balance.subtract(entry.money),
      brl("50.00"),
    );

    expect(rejected).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(0);
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(1 + entries.length);
    expect(entries.every((entry) => entry.isBalanced())).toBe(true);
  });
});
