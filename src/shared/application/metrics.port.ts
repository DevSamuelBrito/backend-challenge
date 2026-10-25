export const METRICS = Symbol("METRICS");

export type ProcessingSource = "http" | "sqs" | "worker";
export type DuplicateType = "idempotent_replay" | "inbox_message";
export type RetrySource = "consumer" | "outbox" | "pending_worker";

export interface Metrics {
  transactionRecorded(kind: string, status: string): void;
  duplicateDetected(type: DuplicateType, source: ProcessingSource): void;
  retryScheduled(source: RetrySource): void;
  deadLettered(reason: string): void;
  lockTimeout(): void;
  walletLockWaited(seconds: number): void;
  outboxLag(seconds: number): void;
  deadLetterQueueSize(messages: number): void;
  processingDuration(source: ProcessingSource, seconds: number): void;
  reconciliationMismatch(): void;
}

export const NO_OP_METRICS: Metrics = {
  transactionRecorded: () => undefined,
  duplicateDetected: () => undefined,
  retryScheduled: () => undefined,
  deadLettered: () => undefined,
  lockTimeout: () => undefined,
  walletLockWaited: () => undefined,
  outboxLag: () => undefined,
  deadLetterQueueSize: () => undefined,
  processingDuration: () => undefined,
  reconciliationMismatch: () => undefined,
};

export async function measureLockWait<T>(metrics: Metrics, acquire: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();

  try {
    return await acquire();
  } finally {
    metrics.walletLockWaited((performance.now() - startedAt) / 1000);
  }
}
