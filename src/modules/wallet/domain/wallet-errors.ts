import { ConflictError, DomainError, NotFoundError } from "../../../shared/domain/domain-error";

export class WalletAlreadyExistsError extends ConflictError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor(playerId: string, currency: string) {
    super(`Já existe uma wallet em ${currency} para o jogador ${playerId}`);
  }
}

export class WalletNotFoundError extends NotFoundError {
  readonly code = "WALLET_NOT_FOUND";

  constructor(walletId: string) {
    super(`Wallet ${walletId} não existe`);
  }
}

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
