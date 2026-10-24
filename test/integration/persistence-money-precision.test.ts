import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerTransactionStatus } from "../../src/modules/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import { WalletLedgerEntry } from "../../src/modules/wallet/domain/wallet-ledger-entry";
import { ledgerEntryMapper } from "../../src/modules/wallet/infrastructure/ledger-entry.mapper";
import { LedgerEntrySchema } from "../../src/modules/wallet/infrastructure/ledger-entry.schema";
import { type PersistenceHarness, startPersistence } from "../support/persistence";
import { aNewTransaction, aNewWallet } from "../support/persistence-builders";
import { AT, brl } from "../support/wagering-builders";

const ABOVE_MAX_SAFE_INTEGER = "9007199254740993.01";
const MAX_MONEY = "999999999999999999.99";

const PRECISE_VALUES = [
  ABOVE_MAX_SAFE_INTEGER,
  MAX_MONEY,
  "123456789012345678.90",
  "9007199254740992.00",
  "0.01",
  "100.10",
];

describe("persistência: dinheiro nunca passa por number", () => {
  let h: PersistenceHarness;

  beforeAll(async () => {
    h = await startPersistence();
  });

  afterAll(async () => {
    await h.close();
  });

  const rawText = async (sql: string, id: string): Promise<string> => {
    const { rows } = await h.db.client.query(sql, [id]);
    return rows[0].value as string;
  };

  test("os valores do teste realmente se perderiam se passassem por number", () => {
    expect(Number.isSafeInteger(Number("9007199254740993"))).toBe(false);
    expect(Number(ABOVE_MAX_SAFE_INTEGER).toFixed(2)).not.toBe(ABOVE_MAX_SAFE_INTEGER);
    expect(Number(MAX_MONEY).toFixed(2)).not.toBe(MAX_MONEY);
  });

  for (const value of PRECISE_VALUES) {
    describe(`valor ${value}`, () => {
      test("Wallet: saldo gravado e relido sem perder um centavo", async () => {
        const wallet = aNewWallet({ balance: brl(value) });

        await h.uow.run(({ wallets }) => wallets.add(wallet));
        const loaded = await h.uow.run(({ wallets }) => wallets.findById(wallet.id));

        expect(loaded?.balance.toJSON().amount).toBe(value);
        expect(loaded).toEqual(wallet);
        expect(
          await rawText("select balance::text as value from wallets where id = $1", wallet.id),
        ).toBe(value);
      });

      test("Wallet.save: o saldo atualizado também mantém a precisão", async () => {
        const wallet = aNewWallet({ balance: brl("0.00") });
        await h.uow.run(({ wallets }) => wallets.add(wallet));

        wallet.credit({
          entryId: randomUUID(),
          transactionId: randomUUID(),
          money: brl(value),
          at: AT,
        });
        await h.uow.run(({ wallets }) => wallets.save(wallet));

        const loaded = await h.uow.run(({ wallets }) => wallets.findById(wallet.id));

        expect(loaded?.balance.toJSON().amount).toBe(value);
        expect(
          await rawText("select balance::text as value from wallets where id = $1", wallet.id),
        ).toBe(value);
      });

      test("WagerTransaction: amount e balanceAfter gravados e relidos exatos", async () => {
        const wallet = aNewWallet();
        await h.uow.run(({ wallets }) => wallets.add(wallet));
        const transaction = aNewTransaction(wallet.id, {
          money: brl(value),
          status: WagerTransactionStatus.Processed,
          balanceAfter: brl(value),
          processedAt: AT,
        });

        await h.uow.run(({ transactions }) => transactions.add(transaction));
        const loaded = await h.uow.run(({ transactions }) => transactions.findById(transaction.id));

        expect(loaded?.money.toJSON().amount).toBe(value);
        expect(loaded?.balanceAfter?.toJSON().amount).toBe(value);
        expect(loaded).toEqual(transaction);
        expect(
          await rawText(
            "select amount::text as value from wager_transactions where id = $1",
            transaction.id,
          ),
        ).toBe(value);
        expect(
          await rawText(
            "select balance_after_amount::text as value from wager_transactions where id = $1",
            transaction.id,
          ),
        ).toBe(value);
      });

      test("WalletLedgerEntry: valor e saldos antes/depois exatos (CREDIT e DEBIT)", async () => {
        const wallet = aNewWallet();
        await h.uow.run(({ wallets }) => wallets.add(wallet));

        const credit = ledgerEntryFor(wallet.id, LedgerDirection.Credit, value);
        const debit = ledgerEntryFor(wallet.id, LedgerDirection.Debit, value);

        await h.uow.run(async ({ transactions, ledger }) => {
          await transactions.add(aNewTransaction(wallet.id, { id: credit.transactionId }));
          await transactions.add(aNewTransaction(wallet.id, { id: debit.transactionId }));
          await ledger.append(credit);
          await ledger.append(debit);
        });

        for (const entry of [credit, debit]) {
          const record = await h.orm.em
            .fork()
            .findOneOrFail(LedgerEntrySchema, { id: entry.id }, { disableIdentityMap: true });
          const loaded = ledgerEntryMapper.toDomain(record);

          expect(loaded).toEqual(entry);
          expect(loaded.isBalanced()).toBe(true);
          expect(
            await rawText(
              "select amount::text as value from wallet_ledger_entries where id = $1",
              entry.id,
            ),
          ).toBe(value);
        }
      });
    });
  }
});

function ledgerEntryFor(walletId: string, direction: LedgerDirection, amount: string) {
  const zero = "0.00";
  const [before, after] = direction === LedgerDirection.Credit ? [zero, amount] : [amount, zero];

  return WalletLedgerEntry.create({
    id: randomUUID(),
    walletId,
    transactionId: randomUUID(),
    direction,
    money: brl(amount),
    balanceBefore: brl(before),
    balanceAfter: brl(after),
    walletVersion: direction === LedgerDirection.Credit ? 2 : 3,
    createdAt: AT,
  });
}
