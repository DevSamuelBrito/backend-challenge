import { Inject, Injectable, Logger } from "@nestjs/common";
import { UNIT_OF_WORK, type UnitOfWork } from "../../../shared/application/unit-of-work.port";
import { WalletNotFoundError } from "../../wallet/domain/wallet-errors";
import {
  backoffDelayMs,
  exhaustionFailureCode,
  isReferenceWaitExhausted,
  type PendingReferenceLimits,
} from "../domain/pending-reference-policy";
import { WagerTransactionStatus } from "../domain/wager-transaction";
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
  ) {}

  async tick(now: Date): Promise<PendingReferenceTickReport> {
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
        report[await this.reprocess(candidate, now)] += 1;
      } catch (error) {
        report.failed += 1;
        this.logger.warn(
          `Falha ao reprocessar a transação ${candidate.transactionId}: ${describe(error)}`,
        );
      }
    }

    return report;
  }

  private reprocess(candidate: PendingReferenceCandidate, now: Date): Promise<CandidateOutcome> {
    return this.unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(candidate.walletId);

      if (!wallet) {
        throw new WalletNotFoundError(candidate.walletId);
      }

      const transaction = await repositories.transactions.findById(candidate.transactionId);

      if (!transaction?.isReferenceRetryDue(now)) {
        return "skipped";
      }

      const settled = await this.settlement.settle(repositories, wallet, transaction, now);

      if (settled.kind === "settled") {
        await repositories.transactions.save(transaction);
        await this.settlement.persistMovement(repositories, wallet, settled.entry);
        await this.settlement.publishOutcome(repositories.outbox, transaction, settled.entry, now);

        return transaction.status === WagerTransactionStatus.Processed ? "processed" : "rejected";
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

        return "exhausted";
      }

      transaction.scheduleReferenceRetry(
        new Date(now.getTime() + backoffDelayMs(transaction.referenceAttempts)),
      );
      await repositories.transactions.save(transaction);

      return "rescheduled";
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
