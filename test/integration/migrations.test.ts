import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmOptions } from "../../src/shared/infrastructure/database/orm-options";
import { testConfig } from "../support/test-config";

describe("migrator do MikroORM no Bun (up/down)", () => {
  let orm: MikroORM;

  async function spikeTableExists(): Promise<boolean> {
    const rows = await orm.em
      .getConnection()
      .execute("select to_regclass('public.spike_migration_check') is not null as exists");
    return (rows[0] as { exists: boolean }).exists;
  }

  beforeAll(async () => {
    orm = await MikroORM.init(buildOrmOptions(testConfig().databaseUrl));
    // Parte sempre de um banco sem migrations aplicadas.
    await orm.migrator.down({ to: 0 });
  });

  afterAll(async () => {
    await orm.close();
  });

  test("a migration está descoberta e pendente", async () => {
    const pending = await orm.migrator.getPending();

    expect(pending.map((migration) => migration.name)).toContain(
      "Migration20261024141718_spike_compat",
    );
  });

  test("up cria a tabela, down remove, e up de novo recria", async () => {
    expect(await spikeTableExists()).toBe(false);

    await orm.migrator.up();
    expect(await spikeTableExists()).toBe(true);
    expect(await orm.migrator.getPending()).toHaveLength(0);

    await orm.migrator.down();
    expect(await spikeTableExists()).toBe(false);
    expect(await orm.migrator.getPending()).toHaveLength(1);

    await orm.migrator.up();
    expect(await spikeTableExists()).toBe(true);
  });

  test("deixa o banco limpo ao final", async () => {
    await orm.migrator.down({ to: 0 });

    expect(await spikeTableExists()).toBe(false);
  });
});
