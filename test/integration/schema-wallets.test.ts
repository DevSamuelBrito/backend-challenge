import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Money, MoneyOutOfRangeError } from "../../src/shared/domain/money";
import {
  createMigratedDatabase,
  expectDatabaseError,
  SQLSTATE,
  type TestDatabase,
} from "../support/database";
import { insertRow, seedWallet, walletRow } from "../support/schema-fixtures";

const MAX_AMOUNT = "999999999999999999.99";
const ABOVE_MAX_AMOUNT = "1000000000000000000.00";

describe("schema: wallets", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createMigratedDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  test("aceita uma wallet válida e devolve o saldo com exatamente 2 casas", async () => {
    const row = await insertRow(db.client, "wallets", walletRow({ balance: "0.10" }));

    expect(row.balance).toBe("0.10");
    expect(row.currency).toBe("BRL");
    expect(row.version).toBe(1);
  });

  test("aceita saldo zero", async () => {
    await expect(seedWallet(db.client, { balance: "0.00" })).resolves.toHaveProperty("id");
  });

  test("rejeita saldo negativo no INSERT", async () => {
    await expectDatabaseError(insertRow(db.client, "wallets", walletRow({ balance: "-0.01" })), {
      code: SQLSTATE.checkViolation,
      constraint: "wallets_balance_non_negative",
    });
  });

  test("rejeita saldo negativo no UPDATE e mantém o saldo anterior", async () => {
    const { id } = await seedWallet(db.client, { balance: "10.00" });

    await expectDatabaseError(
      db.client.query("update wallets set balance = balance - 10.01 where id = $1", [id]),
      { code: SQLSTATE.checkViolation, constraint: "wallets_balance_non_negative" },
    );

    const { rows } = await db.client.query("select balance from wallets where id = $1", [id]);
    expect(rows[0].balance).toBe("10.00");
  });

  test("permite zerar o saldo exatamente", async () => {
    const { id } = await seedWallet(db.client, { balance: "10.00" });

    await db.client.query("update wallets set balance = balance - 10.00 where id = $1", [id]);

    const { rows } = await db.client.query("select balance from wallets where id = $1", [id]);
    expect(rows[0].balance).toBe("0.00");
  });

  test.each([[0], [-1]])("rejeita version %p", async (version) => {
    await expectDatabaseError(insertRow(db.client, "wallets", walletRow({ version })), {
      code: SQLSTATE.checkViolation,
      constraint: "wallets_version_positive",
    });
  });

  test("rejeita wallet duplicada para o mesmo player_id e a mesma moeda", async () => {
    const playerId = "player-duplicado";
    await seedWallet(db.client, { player_id: playerId, currency: "BRL" });

    await expectDatabaseError(
      insertRow(db.client, "wallets", walletRow({ player_id: playerId, currency: "BRL" })),
      { code: SQLSTATE.uniqueViolation, constraint: "wallets_player_currency_key" },
    );
  });

  test("aceita o mesmo player em outra moeda e outro player na mesma moeda", async () => {
    const playerId = "player-multimoeda";
    await seedWallet(db.client, { player_id: playerId, currency: "BRL" });

    await expect(
      seedWallet(db.client, { player_id: playerId, currency: "USD" }),
    ).resolves.toHaveProperty("id");
    await expect(
      seedWallet(db.client, { player_id: "outro-player", currency: "BRL" }),
    ).resolves.toHaveProperty("id");
  });

  test.each([["brl"], ["BR"], ["BRLL"], ["R$A"], ["1RL"]])(
    "rejeita a moeda %p (formato ISO-4217: 3 letras maiúsculas)",
    async (currency) => {
      await expect(insertRow(db.client, "wallets", walletRow({ currency }))).rejects.toThrow();
    },
  );

  test("rejeita id nulo e saldo nulo", async () => {
    await expectDatabaseError(insertRow(db.client, "wallets", walletRow({ id: null })), {
      code: "23502",
    });
    await expectDatabaseError(insertRow(db.client, "wallets", walletRow({ balance: null })), {
      code: "23502",
    });
  });

  test("a faixa do banco é a mesma do Money: aceita o limite e recusa um centavo acima", async () => {
    expect(() => Money.from({ amount: MAX_AMOUNT, currency: "BRL" })).not.toThrow();
    expect(() => Money.from({ amount: ABOVE_MAX_AMOUNT, currency: "BRL" })).toThrow(
      MoneyOutOfRangeError,
    );

    const row = await insertRow(db.client, "wallets", walletRow({ balance: MAX_AMOUNT }));
    expect(row.balance).toBe(MAX_AMOUNT);

    await expectDatabaseError(
      insertRow(db.client, "wallets", walletRow({ balance: ABOVE_MAX_AMOUNT })),
      { code: SQLSTATE.numericOutOfRange },
    );
  });
});
