import { FailureCode } from "./failure-code";

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;

export interface PendingReferenceLimits {
  maxAttempts: number;
  ttlMs: number;
}

export function backoffDelayMs(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new RangeError(`attempts inválido: ${attempts}`);
  }

  return Math.min(BASE_DELAY_MS * 2 ** Math.min(attempts, 30), MAX_DELAY_MS);
}

export function isReferenceWaitExhausted(
  attempts: number,
  createdAt: Date,
  now: Date,
  limits: PendingReferenceLimits,
): boolean {
  return attempts >= limits.maxAttempts || now.getTime() - createdAt.getTime() >= limits.ttlMs;
}

export function exhaustionFailureCode(referenceExists: boolean): FailureCode {
  return referenceExists ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound;
}
