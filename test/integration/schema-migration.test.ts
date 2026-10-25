import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmOptions } from "../../src/shared/infrastructure/database/orm-options";
import { createEmptyDatabase, type TestDatabase } from "../support/database";
import { seedWallet } from "../support/schema-fixtures";

const TABLES = [
  "inbox_messages",
  "outbox_messages",
  "wager_transactions",
  "wallet_ledger_entries",
  "wallets",
];

const FUNCTIONS = ["forbid_table_modification", "guard_wager_transactions_update"];

const TRIGGERS = [
  "wager_transactions.wager_transactions_guard_update",
  "wager_transactions.wager_transactions_no_delete",
  "wager_transactions.wager_transactions_no_truncate",
  "wallet_ledger_entries.wallet_ledger_entries_immutable",
  "wallet_ledger_entries.wallet_ledger_entries_no_truncate",
];

describe("migrations: up, down e up de novo no Postgres real", () => {
  let db: TestDatabase;
  let orm: MikroORM;

  const names = async (sql: string): Promise<string[]> => {
    const result = await db.client.query(sql);
    return result.rows.map((row) => Object.values(row)[0] as string);
  };

  const tables = () =>
    names(
      "select tablename from pg_tables where schemaname = 'public' and tablename not like 'mikro_orm%' order by 1",
    );
  const functions = () =>
    names("select proname from pg_proc where pronamespace = 'public'::regnamespace order by 1");
  const triggers = () =>
    names(
      "select tgrelid::regclass::text || '.' || tgname from pg_trigger where not tgisinternal order by 1",
    );
  const leftovers = () =>
    names(
      `select relname from pg_class
       where relnamespace = 'public'::regnamespace and relname not like 'mikro_orm%'
       order by 1`,
    );

  beforeAll(async () => {
    db = await createEmptyDatabase();
    orm = await MikroORM.init(buildOrmOptions(db.url));
  });

  afterAll(async () => {
    await orm.close();
    await db.close();
  });

  test("o banco começa vazio e a migration está pendente", async () => {
    expect(await tables()).toEqual([]);
    expect(await orm.migrator.getPending()).toHaveLength(2);
  });

  test("up cria as 5 tabelas, as 2 funções e os 5 triggers", async () => {
    await orm.migrator.up();

    expect(await tables()).toEqual(TABLES);
    expect(await functions()).toEqual(FUNCTIONS);
    expect(await triggers()).toEqual(TRIGGERS);
    expect(await orm.migrator.getPending()).toHaveLength(0);
  });

  test("down desfaz tudo: tabelas, índices, sequências, funções e triggers", async () => {
    await orm.migrator.down({ to: 0 });

    expect(await tables()).toEqual([]);
    expect(await functions()).toEqual([]);
    expect(await triggers()).toEqual([]);
    expect(await leftovers()).toEqual([]);
    expect(await orm.migrator.getPending()).toHaveLength(2);
  });

  test("up de novo recria o mesmo schema e o banco volta a funcionar", async () => {
    await orm.migrator.up();

    expect(await tables()).toEqual(TABLES);
    expect(await functions()).toEqual(FUNCTIONS);
    expect(await triggers()).toEqual(TRIGGERS);
    await expect(seedWallet(db.client)).resolves.toHaveProperty("id");
  });

  test("o down funciona mesmo com dados e com triggers de imutabilidade ativos", async () => {
    await orm.migrator.down({ to: 0 });

    expect(await tables()).toEqual([]);
    expect(await leftovers()).toEqual([]);
  });

  test("um ciclo completo extra (up, down, up) continua consistente", async () => {
    await orm.migrator.up();
    await orm.migrator.down({ to: 0 });
    await orm.migrator.up();

    expect(await tables()).toEqual(TABLES);
    expect(await triggers()).toEqual(TRIGGERS);
  });
});
