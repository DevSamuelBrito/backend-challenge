import { FAULT_POINTS, type FaultPoint } from "../shared/application/fault-injector.port";

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

export interface OutboxConfig {
  tickIntervalMs: number;
  batchSize: number;
  sendTimeoutMs: number;
  alertAttempts: number;
}

export interface ConsumerConfig {
  waitSeconds: number;
  batchSize: number;
  concurrency: number;
  visibilityTimeoutSeconds: number;
  backoffBaseSeconds: number;
  backoffMaxSeconds: number;
  sdkTimeoutMs: number;
  shutdownTimeoutMs: number;
  dlqMonitorIntervalMs: number;
}

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

const LOG_LEVELS: readonly LogLevel[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
];

export interface ObservabilityConfig {
  logLevel: LogLevel;
  defaultMetrics: boolean;
}

export interface FaultInjectionConfig {
  point: FaultPoint | undefined;
}

export interface AppConfig {
  port: number;
  roles: readonly AppRole[];
  databaseUrl: string;
  databaseLockTimeoutMs: number;
  pendingReference: PendingReferenceConfig;
  outbox: OutboxConfig;
  consumer: ConsumerConfig;
  observability: ObservabilityConfig;
  faultInjection: FaultInjectionConfig;
  sqs: SqsConfig;
}

const SQS_MAX_LONG_POLL_SECONDS = 20;
const SQS_MAX_BATCH = 10;
const SQS_MAX_VISIBILITY_SECONDS = 43_200;

function positiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  const value = Number(env[name] ?? fallback);

  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} inválido: ${env[name]}`);
  }

  return value;
}

function loadObservabilityConfig(env: Record<string, string | undefined>): ObservabilityConfig {
  const logLevel = (env.LOG_LEVEL ?? "info").toLowerCase();

  if (!LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new Error(`LOG_LEVEL inválido: ${env.LOG_LEVEL}`);
  }

  const defaultMetrics = (env.METRICS_DEFAULT_METRICS ?? "true").toLowerCase();

  if (defaultMetrics !== "true" && defaultMetrics !== "false") {
    throw new Error(`METRICS_DEFAULT_METRICS inválido: ${env.METRICS_DEFAULT_METRICS}`);
  }

  return { logLevel: logLevel as LogLevel, defaultMetrics: defaultMetrics === "true" };
}

function loadFaultInjectionConfig(env: Record<string, string | undefined>): FaultInjectionConfig {
  const enabled = env.ENABLE_FAULT_INJECTION;
  const point = env.FAULT_POINT;

  if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
    throw new Error(`ENABLE_FAULT_INJECTION inválido: ${enabled}`);
  }

  if (enabled !== "true") {
    if (point !== undefined && point !== "") {
      throw new Error("FAULT_POINT exige ENABLE_FAULT_INJECTION=true");
    }

    return { point: undefined };
  }

  if (!FAULT_POINTS.includes(point as FaultPoint)) {
    throw new Error(`FAULT_POINT inválido: ${point}. Pontos: ${FAULT_POINTS.join(", ")}`);
  }

  return { point: point as FaultPoint };
}

function loadConsumerConfig(env: Record<string, string | undefined>): ConsumerConfig {
  const backoffBaseSeconds = positiveInteger(
    env,
    "CONSUMER_BACKOFF_BASE_SECONDS",
    1,
    SQS_MAX_VISIBILITY_SECONDS,
  );
  const backoffMaxSeconds = positiveInteger(
    env,
    "CONSUMER_BACKOFF_MAX_SECONDS",
    60,
    SQS_MAX_VISIBILITY_SECONDS,
  );

  if (backoffMaxSeconds < backoffBaseSeconds) {
    throw new Error(
      `CONSUMER_BACKOFF_MAX_SECONDS (${backoffMaxSeconds}) não pode ser menor que CONSUMER_BACKOFF_BASE_SECONDS (${backoffBaseSeconds})`,
    );
  }

  return {
    waitSeconds: positiveInteger(env, "CONSUMER_WAIT_SECONDS", 20, SQS_MAX_LONG_POLL_SECONDS),
    batchSize: positiveInteger(env, "CONSUMER_BATCH_SIZE", 10, SQS_MAX_BATCH),
    concurrency: positiveInteger(env, "CONSUMER_CONCURRENCY", 5),
    visibilityTimeoutSeconds: positiveInteger(
      env,
      "CONSUMER_VISIBILITY_TIMEOUT_SECONDS",
      30,
      SQS_MAX_VISIBILITY_SECONDS,
    ),
    backoffBaseSeconds,
    backoffMaxSeconds,
    sdkTimeoutMs: positiveInteger(env, "CONSUMER_SDK_TIMEOUT_MS", 5000),
    shutdownTimeoutMs: positiveInteger(env, "CONSUMER_SHUTDOWN_TIMEOUT_MS", 30_000),
    dlqMonitorIntervalMs: positiveInteger(env, "DLQ_MONITOR_INTERVAL_MS", 30_000),
  };
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

  const sqs: SqsConfig = {
    region: env.AWS_REGION ?? "us-east-1",
    endpoint: env.SQS_ENDPOINT ?? "http://localhost:4566",
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? "test",
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "test",
    transactionsQueue: env.SQS_TRANSACTIONS_QUEUE ?? "wager-transactions.fifo",
    transactionsDlq: env.SQS_TRANSACTIONS_DLQ ?? "wager-transactions-dlq.fifo",
    eventsQueue: env.SQS_EVENTS_QUEUE ?? "wager-events.fifo",
  };

  if ([sqs.transactionsQueue, sqs.transactionsDlq].includes(sqs.eventsQueue)) {
    throw new Error(
      `SQS_EVENTS_QUEUE não pode ser a fila de entrada nem a DLQ: ${sqs.eventsQueue}`,
    );
  }

  if (sqs.transactionsQueue === sqs.transactionsDlq) {
    throw new Error(
      `SQS_TRANSACTIONS_DLQ não pode ser a própria fila de entrada: ${sqs.transactionsDlq}`,
    );
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
    outbox: {
      tickIntervalMs: positiveInteger(env, "OUTBOX_INTERVAL_MS", 1000),
      batchSize: positiveInteger(env, "OUTBOX_BATCH_SIZE", 10),
      sendTimeoutMs: positiveInteger(env, "OUTBOX_SEND_TIMEOUT_MS", 3000),
      alertAttempts: positiveInteger(env, "OUTBOX_ALERT_ATTEMPTS", 10),
    },
    consumer: loadConsumerConfig(env),
    observability: loadObservabilityConfig(env),
    faultInjection: loadFaultInjectionConfig(env),
    sqs,
  };
}
