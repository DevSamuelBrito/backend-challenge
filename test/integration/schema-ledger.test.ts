import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import {
  createMigratedDatabase,
  expectDatabaseError,
  SQLSTATE,
  type TestDatabase,
} from "../support/database";
import { insertRow, ledgerRow, seedTransaction, seedWallet } from "../support/schema-fixtures";

const MAX_AMOUNT = "999999999999999999.99";
const ONE_CENT_BELOW_MAX = "999999999999999999.98";

describe("schema: wallet_ledger_entries", () => {
  let db: TestDatabase;
  let wallet: { id: string };

  const newTransaction = (walletId = wallet.id) => seedTransaction(db.client, walletId);

  const insertEntry = async (overrides = {}, walletId = wallet.id) => {
    const transaction = await newTransaction(walletId);
    return insertRow(
      db.client,
      "wallet_ledger_entries",
      ledgerRow(walletId, transaction.id, overrides),
    );
  };

  beforeAll(async () => {
    db = await createMigratedDatabase();
    wallet = await seedWallet(db.client);
  });

  afterAll(async () => {
    await db.close();
  });

  describe("aritmética (CHECK)", () => {
    test("aceita um débito balanceado: 100.00 − 80.00 = 20.00", async () => {
      const row = await insertEntry({ wallet_version: 2 });

      expect(row.direction).toBe("DEBIT");
      expect(row.balance_after).toBe("20.00");
    });

    test("aceita um crédito balanceado: 20.00 + 5.50 = 25.50", async () => {
      await expect(
        insertEntry({
          direction: "CREDIT",
          amount: "5.50",
          balance_before: "20.00",
          balance_after: "25.50",
          wallet_version: 3,
        }),
      ).resolves.toHaveProperty("id");
    });

    test.each([
      ["débito com saldo posterior errado", { balance_after: "21.00" }],
      ["débito que soma em vez de subtrair", { balance_after: "180.00" }],
      [
        "crédito que subtrai em vez de somar",
        { direction: "CREDIT", balance_before: "100.00", balance_after: "20.00" },
      ],
      [
        "crédito com saldo posterior errado",
        { direction: "CREDIT", balance_before: "100.00", balance_after: "181.00" },
      ],
      ["lançamento que não muda o saldo", { balance_after: "100.00" }],
      ["diferença de um centavo", { balance_after: "20.01" }],
    ])("rejeita aritmética errada: %s", async (_name, overrides) => {
      await expectDatabaseError(insertEntry({ wallet_version: 20, ...overrides }), {
        code: SQLSTATE.checkViolation,
        constraint: "wallet_ledger_entries_arithmetic",
      });
    });

    test("rejeita direção inválida", async () => {
      await expectDatabaseError(insertEntry({ wallet_version: 21, direction: "MOVE" }), {
        code: SQLSTATE.checkViolation,
      });
    });

    test("aceita o limite do Money: débito de um centavo a partir do saldo máximo", async () => {
      const row = await insertEntry({
        wallet_version: 22,
        amount: "0.01",
        balance_before: MAX_AMOUNT,
        balance_after: ONE_CENT_BELOW_MAX,
      });

      expect(row.balance_before).toBe(MAX_AMOUNT);
    });
  });

  describe("domínio dos valores", () => {
    test.each([["0.00"], ["-1.00"]])("rejeita valor %s", async (amount) => {
      await expectDatabaseError(
        insertEntry({ wallet_version: 30, amount, balance_after: "100.00" }),
        { code: SQLSTATE.checkViolation, constraint: "wallet_ledger_entries_amount_positive" },
      );
    });

    test("rejeita saldo anterior negativo", async () => {
      await expectDatabaseError(
        insertEntry({
          wallet_version: 31,
          direction: "CREDIT",
          amount: "30.00",
          balance_before: "-10.00",
          balance_after: "20.00",
        }),
        {
          code: SQLSTATE.checkViolation,
          constraint: "wallet_ledger_entries_balance_before_non_negative",
        },
      );
    });

    test("rejeita saldo posterior negativo (um débito nunca deixa a conta no vermelho)", async () => {
      await expectDatabaseError(
        insertEntry({
          wallet_version: 32,
          amount: "30.00",
          balance_before: "10.00",
          balance_after: "-20.00",
        }),
        {
          code: SQLSTATE.checkViolation,
          constraint: "wallet_ledger_entries_balance_after_non_negative",
        },
      );
    });

    test("rejeita wallet_version 0", async () => {
      await expectDatabaseError(insertEntry({ wallet_version: 0 }), {
        code: SQLSTATE.checkViolation,
        constraint: "wallet_ledger_entries_wallet_version_positive",
      });
    });

    test("rejeita moeda fora do formato ISO-4217", async () => {
      await expectDatabaseError(insertEntry({ wallet_version: 33, currency: "brl" }), {
        code: SQLSTATE.checkViolation,
        constraint: "wallet_ledger_entries_currency_format",
      });
    });
  });

  describe("unicidade", () => {
    test("rejeita dois lançamentos para a mesma transação", async () => {
      const transaction = await newTransaction();
      await insertRow(
        db.client,
        "wallet_ledger_entries",
        ledgerRow(wallet.id, transaction.id, { wallet_version: 40 }),
      );

      await expectDatabaseError(
        insertRow(
          db.client,
          "wallet_ledger_entries",
          ledgerRow(wallet.id, transaction.id, { wallet_version: 41 }),
        ),
        { code: SQLSTATE.uniqueViolation, constraint: "wallet_ledger_entries_transaction_id_key" },
      );
    });

    test("rejeita dois lançamentos com a mesma versão na mesma wallet (cadeia sem bifurcação)", async () => {
      await insertEntry({ wallet_version: 50 });

      await expectDatabaseError(insertEntry({ wallet_version: 50 }), {
        code: SQLSTATE.uniqueViolation,
        constraint: "wallet_ledger_entries_wallet_version_key",
      });
    });

    test("a mesma versão em outra wallet é permitida", async () => {
      const other = await seedWallet(db.client);

      await insertEntry({ wallet_version: 60 });
      await expect(insertEntry({ wallet_version: 60 }, other.id)).resolves.toHaveProperty("id");
    });

    test("50 lançamentos simultâneos para a mesma transação: exatamente um vence", async () => {
      const transaction = await newTransaction();
      const clients = await Promise.all(Array.from({ length: 50 }, () => db.connect()));

      const results = await Promise.allSettled(
        Array.from({ length: 50 }, (_, index) =>
          insertRow(
            clients[index] as Client,
            "wallet_ledger_entries",
            ledgerRow(wallet.id, transaction.id, { wallet_version: 100 + index }),
          ),
        ),
      );

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results.filter((item) => item.status === "rejected")) {
        expect((result as PromiseRejectedResult).reason.code).toBe(SQLSTATE.uniqueViolation);
      }
    });

    test("seq cresce a cada lançamento, servindo de cursor estável", async () => {
      const seqs: bigint[] = [];

      for (let index = 0; index < 3; index++) {
        const row = await insertEntry({ wallet_version: 200 + index });
        seqs.push(BigInt(row.seq as string));
      }

      expect(seqs[1] as bigint).toBeGreaterThan(seqs[0] as bigint);
      expect(seqs[2] as bigint).toBeGreaterThan(seqs[1] as bigint);
    });
  });

  describe("integridade referencial", () => {
    test("rejeita wallet inexistente", async () => {
      const transaction = await newTransaction();

      await expectDatabaseError(
        insertRow(
          db.client,
          "wallet_ledger_entries",
          ledgerRow(randomUUID(), transaction.id, { wallet_version: 70 }),
        ),
        { code: SQLSTATE.foreignKeyViolation, constraint: "wallet_ledger_entries_wallet_id_fkey" },
      );
    });

    test("rejeita transação inexistente", async () => {
      await expectDatabaseError(
        insertRow(
          db.client,
          "wallet_ledger_entries",
          ledgerRow(wallet.id, randomUUID(), { wallet_version: 71 }),
        ),
        {
          code: SQLSTATE.foreignKeyViolation,
          constraint: "wallet_ledger_entries_transaction_id_fkey",
        },
      );
    });
  });

  describe("imutabilidade (trigger)", () => {
    async function existingEntry() {
      return insertEntry({ wallet_version: 300 + Math.floor(Math.random() * 1_000_000) });
    }

    const readEntry = async (id: unknown) => {
      const { rows } = await db.client.query("select * from wallet_ledger_entries where id = $1", [
        id,
      ]);
      return rows[0];
    };

    test.each([
      ["amount = 1.00"],
      ["balance_after = 21.00"],
      ["direction = 'CREDIT'"],
      ["wallet_version = 999999"],
      ["created_at = now()"],
      ["amount = amount"],
    ])("UPDATE ... SET %s é recusado e a linha continua igual", async (assignments) => {
      const entry = await existingEntry();

      await expectDatabaseError(
        db.client.query(`update wallet_ledger_entries set ${assignments} where id = $1`, [
          entry.id,
        ]),
        { code: SQLSTATE.integrityViolation, message: /wallet_ledger_entries é imutável: UPDATE/ },
      );

      expect(await readEntry(entry.id)).toEqual(entry);
    });

    test("DELETE é recusado e a linha continua igual", async () => {
      const entry = await existingEntry();

      await expectDatabaseError(
        db.client.query("delete from wallet_ledger_entries where id = $1", [entry.id]),
        { code: SQLSTATE.integrityViolation, message: /wallet_ledger_entries é imutável: DELETE/ },
      );

      expect(await readEntry(entry.id)).toEqual(entry);
    });

    test("DELETE sem WHERE também é recusado", async () => {
      await existingEntry();

      await expectDatabaseError(db.client.query("delete from wallet_ledger_entries"), {
        code: SQLSTATE.integrityViolation,
        message: /imutável: DELETE/,
      });
    });

    test("TRUNCATE é recusado", async () => {
      const entry = await existingEntry();

      await expectDatabaseError(db.client.query("truncate wallet_ledger_entries"), {
        code: SQLSTATE.integrityViolation,
        message: /wallet_ledger_entries é imutável: TRUNCATE/,
      });

      expect(await readEntry(entry.id)).toEqual(entry);
    });

    test("UPDATE que não casa com nenhuma linha não é erro (nada foi alterado)", async () => {
      const result = await db.client.query(
        "update wallet_ledger_entries set amount = 1.00 where id = $1",
        [randomUUID()],
      );

      expect(result.rowCount).toBe(0);
    });

    test("o erro é uma violação de integridade, distinta de uma falha qualquer do banco", async () => {
      const entry = await existingEntry();

      try {
        await db.client.query("delete from wallet_ledger_entries where id = $1", [entry.id]);
        expect.unreachable();
      } catch (error) {
        expect((error as { code: string }).code).toBe("23000");
      }
    });
  });
});
