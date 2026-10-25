import { describe, expect, test } from "bun:test";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/wager-transaction";
import { InvalidTransactionStateError } from "../../src/modules/wagering/domain/wager-transaction-errors";
import { aTransaction } from "../support/wagering-builders";

const NEXT = new Date("2026-01-01T12:00:03.000Z");

const pendingTransaction = (overrides = {}) =>
  aTransaction({
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: "ext-0",
    status: WagerTransactionStatus.PendingReference,
    nextAttemptAt: NEXT,
    ...overrides,
  });

describe("WagerTransaction: reprocessamento de PENDING_REFERENCE (etapa 10)", () => {
  test("countReferenceAttempt incrementa uma tentativa por chamada", () => {
    const transaction = pendingTransaction();

    transaction.countReferenceAttempt();
    transaction.countReferenceAttempt();

    expect(transaction.referenceAttempts).toBe(2);
  });

  test("scheduleReferenceRetry troca a próxima tentativa sem mexer nas tentativas", () => {
    const transaction = pendingTransaction({ referenceAttempts: 4 });
    const later = new Date(NEXT.getTime() + 8000);

    transaction.scheduleReferenceRetry(later);

    expect(transaction.nextAttemptAt).toEqual(later);
    expect(transaction.referenceAttempts).toBe(4);
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
  });

  test.each([
    WagerTransactionStatus.Pending,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ])("contar tentativa ou reagendar fora de PENDING_REFERENCE (%s) é inválido", (status) => {
    const transaction = aTransaction({ status });

    expect(() => transaction.countReferenceAttempt()).toThrow(InvalidTransactionStateError);
    expect(() => transaction.scheduleReferenceRetry(NEXT)).toThrow(InvalidTransactionStateError);
    expect(transaction.referenceAttempts).toBe(0);
  });

  test("isReferenceRetryDue: só PENDING_REFERENCE com next_attempt_at <= agora", () => {
    const transaction = pendingTransaction();

    expect(transaction.isReferenceRetryDue(new Date(NEXT.getTime() - 1))).toBe(false);
    expect(transaction.isReferenceRetryDue(NEXT)).toBe(true);
    expect(transaction.isReferenceRetryDue(new Date(NEXT.getTime() + 1))).toBe(true);
  });

  test("isReferenceRetryDue é falso sem next_attempt_at e fora de PENDING_REFERENCE", () => {
    expect(pendingTransaction({ nextAttemptAt: undefined }).isReferenceRetryDue(NEXT)).toBe(false);

    for (const status of [
      WagerTransactionStatus.Pending,
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ]) {
      expect(aTransaction({ status, nextAttemptAt: NEXT }).isReferenceRetryDue(NEXT)).toBe(false);
    }
  });
});
