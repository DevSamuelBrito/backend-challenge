import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  METRICS,
  type Metrics,
  measureLockWait,
  NO_OP_METRICS,
} from "../../../shared/application/metrics.port";
import { enrichContext, runWithContext } from "../../../shared/application/request-context";
import { describeError } from "../../../shared/application/safe-error";
import { UNIT_OF_WORK, type UnitOfWork } from "../../../shared/application/unit-of-work.port";
import { WalletNotFoundError } from "../../wallet/domain/wallet-errors";
import {
  backoffDelayMs,
  exhaustionFailureCode,
  isReferenceWaitExhausted,
  type PendingReferenceLimits,
} from "../domain/pending-reference-policy";
import { type WagerTransactionKind, WagerTransactionStatus } from "../domain/wager-transaction";
import { WagerSettlement } from "./wager-settlement";
import type { PendingReferenceCandidate } from "./wager-transaction.repository";

export const PENDING_REFERENCE_SETTINGS = Symbol("PENDING_REFERENCE_SETTINGS");

export interface PendingReferenceSettings extends PendingReferenceLimits {
  batchSize: number;
}

export type CandidateOutcome = "processed" | "rejected" | "exhausted" | "rescheduled" | "skipped";

export interface PendingReferenceTickReport {
  candidates: number;
  processed: number;
  rejected: number;
  exhausted: number;
  rescheduled: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(PENDING_REFERENCE_SETTINGS) private readonly settings: PendingReferenceSettings,
    private readonly settlement: WagerSettlement,
    @Inject(METRICS) private readonly metrics: Metrics = NO_OP_METRICS,
  ) {}

  tick(now: Date): Promise<PendingReferenceTickReport> {
    return runWithContext({ correlationId: randomUUID() }, () => this.runTick(now));
  }

  private async runTick(now: Date): Promise<PendingReferenceTickReport> {
    const candidates = await this.unitOfWork.run(({ transactions }) =>
      transactions.findDueForReference(now, this.settings.batchSize),
    );

    const report: PendingReferenceTickReport = {
      candidates: candidates.length,
      processed: 0,
      rejected: 0,
      exhausted: 0,
      rescheduled: 0,
      skipped: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        report[await this.reprocessInContext(candidate, now)] += 1;
      } catch (error) {
        report.failed += 1;
        this.logger.warn({
          event: "pending_worker.candidate_failed",
          transactionId: candidate.transactionId,
          walletId: candidate.walletId,
          error: describeError(error),
        });
      }
    }

    return report;
  }

  private reprocessInContext(
    candidate: PendingReferenceCandidate,
    now: Date,
  ): Promise<CandidateOutcome> {
    return runWithContext(
      {
        correlationId: randomUUID(),
        transactionId: candidate.transactionId,
        walletId: candidate.walletId,
      },
      async () => {
        const startedAt = performance.now();

        try {
          const { outcome, kind } = await this.reprocess(candidate, now);
          this.record(outcome, kind);

          return outcome;
        } finally {
          this.metrics.processingDuration("worker", (performance.now() - startedAt) / 1000);
        }
      },
    );
  }

  private record(outcome: CandidateOutcome, kind: WagerTransactionKind | undefined): void {
    if (outcome === "rescheduled") {
      this.metrics.retryScheduled("pending_worker");
    }

    if (kind && (outcome === "processed" || outcome === "rejected" || outcome === "exhausted")) {
      const status =
        outcome === "processed"
          ? WagerTransactionStatus.Processed
          : WagerTransactionStatus.Rejected;

      this.metrics.transactionRecorded(kind, status);
    }

    if (outcome !== "skipped") {
      this.logger.log({ event: `pending_worker.${outcome}`, kind });
    }
  }

  private reprocess(
    candidate: PendingReferenceCandidate,
    now: Date,
  ): Promise<{ outcome: CandidateOutcome; kind?: WagerTransactionKind }> {
    return this.unitOfWork.run(async (repositories) => {
      const wallet = await measureLockWait(this.metrics, () =>
        repositories.wallets.findByIdForUpdate(candidate.walletId),
      );

      if (!wallet) {
        throw new WalletNotFoundError(candidate.walletId);
      }

      const transaction = await repositories.transactions.findById(candidate.transactionId);

      if (!transaction?.isReferenceRetryDue(now)) {
        return { outcome: "skipped" };
      }

      enrichContext({ providerId: transaction.providerId });

      const settled = await this.settlement.settle(repositories, wallet, transaction, now);

      if (settled.kind === "settled") {
        await repositories.transactions.save(transaction);
        await this.settlement.persistMovement(repositories, wallet, settled.entry);
        await this.settlement.publishOutcome(repositories.outbox, transaction, settled.entry, now);

        return {
          outcome:
            transaction.status === WagerTransactionStatus.Processed ? "processed" : "rejected",
          kind: transaction.kind,
        };
      }

      transaction.countReferenceAttempt();

      if (
        isReferenceWaitExhausted(transaction.referenceAttempts, transaction.createdAt, now, {
          maxAttempts: this.settings.maxAttempts,
          ttlMs: this.settings.ttlMs,
        })
      ) {
        transaction.reject(exhaustionFailureCode(settled.referenceFound), wallet.balance, now);
        await repositories.transactions.save(transaction);
        await this.settlement.publishOutcome(repositories.outbox, transaction, undefined, now);

        return { outcome: "exhausted", kind: transaction.kind };
      }

      transaction.scheduleReferenceRetry(
        new Date(now.getTime() + backoffDelayMs(transaction.referenceAttempts)),
      );
      await repositories.transactions.save(transaction);

      return { outcome: "rescheduled", kind: transaction.kind };
    });
  }
}
