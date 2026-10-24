import { DomainError } from "../../../shared/domain/domain-error";

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
