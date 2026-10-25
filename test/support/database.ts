import { expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Client, type DatabaseError } from "pg";
import { buildOrmOptions } from "../../src/shared/infrastructure/database/orm-options";
import { testConfig } from "./test-config";

const MIGRATIONS_DIR = "migrations";
const TEMPLATE_LOCK_KEY = 7_770_001;

export const HARNESS_APPLICATION = "test-harness";

export async function setDatabaseAvailable(database: TestDatabase, available: boolean) {
  await withAdminClient(async (admin) => {
    await admin.query(
      `alter database "${database.name}" with allow_connections ${available ? "true" : "false"}`,
    );

    if (!available) {
      await admin.query(
        `select pg_terminate_backend(pid)
           from pg_stat_activity
          where datname = $1 and application_name <> $2`,
        [database.name, HARNESS_APPLICATION],
      );
    }
  });
}

export interface TestDatabase {
  name: string;
  url: string;
  client: Client;
  connect(): Promise<Client>;
  close(): Promise<void>;
}

function urlFor(database: string): string {
  const url = new URL(testConfig().databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withAdminClient<T>(operation: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();

  try {
    return await operation(admin);
  } finally {
    await admin.end();
  }
}

function templateName(): string {
  const hash = createHash("sha256");

  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    hash.update(file).update(readFileSync(`${MIGRATIONS_DIR}/${file}`));
  }

  return `wagering_tpl_${hash.digest("hex").slice(0, 12)}`;
}

async function buildTemplate(): Promise<string> {
  const name = templateName();

  await withAdminClient(async (admin) => {
    await admin.query("select pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);

    try {
      const existing = await admin.query("select 1 from pg_database where datname = $1", [name]);

      if (existing.rowCount === 0) {
        const stale = await admin.query(
          "select datname from pg_database where datname like 'wagering_tpl_%' and datname <> $1",
          [name],
        );
        for (const { datname } of stale.rows) {
          await admin.query(`drop database if exists "${datname}" with (force)`);
        }

        await admin.query(`create database "${name}"`);

        try {
          const orm = await MikroORM.init(buildOrmOptions(urlFor(name)));
          try {
            await orm.migrator.up();
          } finally {
            await orm.close();
          }
        } catch (error) {
          await admin.query(`drop database if exists "${name}" with (force)`);
          throw error;
        }
      }
    } finally {
      await admin.query("select pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY]);
    }
  });

  return name;
}

let templateReady: Promise<string> | undefined;

function ensureTemplate(): Promise<string> {
  templateReady ??= buildTemplate();
  return templateReady;
}

async function createDatabase(template: string | undefined): Promise<TestDatabase> {
  const name = `wagering_t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const source = template ? ` template "${template}"` : "";

  await withAdminClient((admin) => admin.query(`create database "${name}"${source}`));

  const url = urlFor(name);
  const clients: Client[] = [];

  const connect = async (): Promise<Client> => {
    const client = new Client({ connectionString: url, application_name: HARNESS_APPLICATION });
    await client.connect();
    clients.push(client);
    return client;
  };

  const client = await connect();

  return {
    name,
    url,
    client,
    connect,
    close: async () => {
      await Promise.all(clients.map((connected) => connected.end().catch(() => undefined)));
      await withAdminClient((admin) =>
        admin.query(`drop database if exists "${name}" with (force)`),
      );
    },
  };
}

export async function createMigratedDatabase(): Promise<TestDatabase> {
  return createDatabase(await ensureTemplate());
}

export function createEmptyDatabase(): Promise<TestDatabase> {
  return createDatabase(undefined);
}

export async function expectDatabaseError(
  operation: Promise<unknown>,
  expected: { code: string; constraint?: string; message?: RegExp },
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const failure = error as DatabaseError;

    expect(failure.code).toBe(expected.code);
    if (expected.constraint) {
      expect(failure.constraint).toBe(expected.constraint);
    }
    if (expected.message) {
      expect(failure.message).toMatch(expected.message);
    }
    return;
  }

  expect.unreachable("o banco deveria ter recusado a operação, mas ela foi aceita");
}

export const SQLSTATE = {
  uniqueViolation: "23505",
  checkViolation: "23514",
  foreignKeyViolation: "23503",
  integrityViolation: "23000",
  numericOutOfRange: "22003",
} as const;
