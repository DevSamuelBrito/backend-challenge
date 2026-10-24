export type AppRole = "api" | "consumer" | "outbox" | "pending-worker";

const ALL_ROLES: readonly AppRole[] = ["api", "consumer", "outbox", "pending-worker"];

export interface SqsConfig {
  region: string;
  endpoint: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  transactionsQueue: string;
  transactionsDlq: string;
  eventsQueue: string;
}

export interface AppConfig {
  port: number;
  roles: readonly AppRole[];
  databaseUrl: string;
  databaseLockTimeoutMs: number;
  sqs: SqsConfig;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const port = Number(env.PORT ?? 3000);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT inválida: ${env.PORT}`);
  }

  const databaseLockTimeoutMs = Number(env.DB_LOCK_TIMEOUT_MS ?? 5000);

  if (!Number.isInteger(databaseLockTimeoutMs) || databaseLockTimeoutMs <= 0) {
    throw new Error(`DB_LOCK_TIMEOUT_MS inválido: ${env.DB_LOCK_TIMEOUT_MS}`);
  }

  const rawRoles = (env.APP_ROLES ?? ALL_ROLES.join(","))
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role.length > 0);

  const unknown = rawRoles.filter((role) => !ALL_ROLES.includes(role as AppRole));

  if (unknown.length > 0) {
    throw new Error(`APP_ROLES contém papéis desconhecidos: ${unknown.join(", ")}`);
  }

  return {
    port,
    roles: rawRoles as AppRole[],
    databaseUrl: env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering",
    databaseLockTimeoutMs,
    sqs: {
      region: env.AWS_REGION ?? "us-east-1",
      endpoint: env.SQS_ENDPOINT ?? "http://localhost:4566",
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "test",
      transactionsQueue: env.SQS_TRANSACTIONS_QUEUE ?? "wager-transactions.fifo",
      transactionsDlq: env.SQS_TRANSACTIONS_DLQ ?? "wager-transactions-dlq.fifo",
      eventsQueue: env.SQS_EVENTS_QUEUE ?? "wager-events.fifo",
    },
  };
}
