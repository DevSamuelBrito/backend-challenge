import { ConflictError, DomainError } from "../../../shared/domain/domain-error";

export class IdempotencyConflictError extends ConflictError {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(idempotencyKey: string) {
    super(`A Idempotency-Key ${idempotencyKey} já foi usada com um payload diferente`);
  }
}

export class ExternalTransactionConflictError extends ConflictError {
  readonly code = "EXTERNAL_TRANSACTION_CONFLICT";

  constructor(providerId: string, externalTransactionId: string) {
    super(
      `A transação ${externalTransactionId} do provedor ${providerId} já existe com outra Idempotency-Key`,
    );
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";

  constructor(from: string, to: string) {
    super(`Transição de estado inválida: ${from} → ${to}`);
  }
}

export class InvalidWagerTransactionError extends DomainError {
  constructor(
    readonly code:
      | "WAGER_REFERENCE_REQUIRED"
      | "WAGER_AMOUNT_NOT_POSITIVE"
      | "WAGER_NO_LEDGER_ENTRY"
      | "WAGER_INVALID_REFERENCE_KIND",
    message: string,
  ) {
    super(message);
  }
}
