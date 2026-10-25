import type { WagerTransaction } from "../domain/wager-transaction";

export interface PendingReferenceCandidate {
  transactionId: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  add(transaction: WagerTransaction): Promise<void>;
  save(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  hasProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
  findDueForReference(now: Date, limit: number): Promise<PendingReferenceCandidate[]>;
}
