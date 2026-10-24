export type DuplicatedConstraint = "idempotency_key" | "external_transaction";

export class DuplicateTransactionError extends Error {
  constructor(readonly constraint: DuplicatedConstraint) {
    super(`Transação duplicada: violação de unicidade em ${constraint}`);
    this.name = "DuplicateTransactionError";
  }
}
