import type { Client } from "pg";
import { PendingReferenceWorker } from "../../src/modules/wagering/application/pending-reference-worker";
import { PendingReferenceScheduler } from "../../src/modules/wagering/infrastructure/pending-reference.scheduler";
import type { AppInstance } from "./wallet-api";

export const workerOf = (instance: AppInstance): PendingReferenceWorker =>
  instance.app.get(PendingReferenceWorker, { strict: false });

export const schedulerOf = (instance: AppInstance): PendingReferenceScheduler =>
  instance.app.get(PendingReferenceScheduler, { strict: false });

export interface PendingRow {
  id: string;
  kind: string;
  status: string;
  failure_code: string | null;
  reference_transaction_id: string | null;
  reference_attempts: number;
  balance_after_amount: string | null;
  next_attempt_at: Date | null;
  created_at: Date;
  processed_at: Date | null;
}

export async function rowOf(client: Client, transactionId: string): Promise<PendingRow> {
  const { rows } = await client.query(
    `select id, kind, status, failure_code, reference_transaction_id, reference_attempts,
            balance_after_amount::text as balance_after_amount, next_attempt_at, created_at,
            processed_at
       from wager_transactions where id = $1`,
    [transactionId],
  );

  return rows[0] as PendingRow;
}
