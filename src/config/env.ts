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

export interface PendingReferenceConfig {
  maxAttempts: number;
  ttlMs: number;
  tickIntervalMs: number;
  batchSize: number;
}

export interface AppConfig {
  port: number;
  roles: readonly AppRole[];
  databaseUrl: string;
  databaseLockTimeoutMs: number;
  pendingReference: PendingReferenceConfig;
  sqs: SqsConfig;
}

function positiveInteger(env: Record<string, string | undefined>, name: string, fallback: number) {
  const value = Number(env[name] ?? fallback);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} inválido: ${env[name]}`);
  }

  return value;
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
    pendingReference: {
      maxAttempts: positiveInteger(env, "PENDING_REFERENCE_MAX_ATTEMPTS", 10),
      ttlMs: positiveInteger(env, "PENDING_REFERENCE_TTL_MS", 15 * 60 * 1000),
      tickIntervalMs: positiveInteger(env, "PENDING_WORKER_INTERVAL_MS", 1000),
      batchSize: positiveInteger(env, "PENDING_WORKER_BATCH_SIZE", 20),
    },
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
