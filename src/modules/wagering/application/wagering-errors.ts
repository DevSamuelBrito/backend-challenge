import { NotImplementedYetError } from "../../../shared/domain/domain-error";

export type DuplicatedConstraint = "idempotency_key" | "external_transaction";

export class DuplicateTransactionError extends Error {
  constructor(readonly constraint: DuplicatedConstraint) {
    super(`Transação duplicada: violação de unicidade em ${constraint}`);
    this.name = "DuplicateTransactionError";
  }
}

export class KindNotSupportedYetError extends NotImplementedYetError {
  readonly code = "KIND_NOT_SUPPORTED_YET";

  constructor(description: string) {
    super(`${description} ainda não é suportado`);
  }
}
