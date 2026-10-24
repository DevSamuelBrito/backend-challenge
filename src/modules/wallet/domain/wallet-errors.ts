import { DomainError } from "../../../shared/domain/domain-error";

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(walletId: string) {
    super(`Saldo insuficiente na wallet ${walletId}`);
  }
}

export class InvalidWalletError extends DomainError {
  constructor(
    readonly code: "WALLET_INVALID_BALANCE" | "WALLET_INVALID_MOVEMENT_AMOUNT",
    message: string,
  ) {
    super(message);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "LEDGER_ENTRY_INVALID";
}
