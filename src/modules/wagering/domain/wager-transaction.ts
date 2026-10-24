import { createHash } from "node:crypto";
import type { Money } from "../../../shared/domain/money";
import { LedgerDirection } from "../../wallet/domain/ledger-direction";
import { FailureCode } from "./failure-code";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "./wager-transaction-errors";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

const ALLOWED_TRANSITIONS: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

export const OPENING_PROVIDER_ID = "internal";
export const OPENING_ROUND_AND_GAME_ID = "opening";

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

function openingPayloadHash(props: CreateOpeningTransactionProps, idempotencyKey: string): string {
  const canonical = JSON.stringify({
    externalTransactionId: props.walletId,
    gameId: OPENING_ROUND_AND_GAME_ID,
    idempotencyKey,
    kind: WagerTransactionKind.Opening,
    money: props.money.toJSON(),
    playerId: props.playerId,
    providerId: OPENING_PROVIDER_ID,
    roundId: OPENING_ROUND_AND_GAME_ID,
    walletId: props.walletId,
  });

  return createHash("sha256").update(canonical).digest("hex");
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balanceAfter?: Money;
  processedAt?: Date;
  referenceAttempts?: number;
  nextAttemptAt?: Date;
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _balanceAfter: Money | undefined;
  private _processedAt: Date | undefined;
  private _referenceAttempts: number;
  private _nextAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._balanceAfter = state.balanceAfter;
    this._processedAt = state.processedAt;
    this._referenceAttempts = state.referenceAttempts ?? 0;
    this._nextAttemptAt = state.nextAttemptAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        "WAGER_AMOUNT_NOT_POSITIVE",
        "Valor da transação deve ser positivo",
      );
    }

    const needsReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;

    if (needsReference && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(
        "WAGER_REFERENCE_REQUIRED",
        `${props.kind} exige referenceExternalTransactionId`,
      );
    }

    return new WagerTransaction({ ...props, status: WagerTransactionStatus.Pending });
  }

  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        "WAGER_AMOUNT_NOT_POSITIVE",
        "Transação OPENING só existe para saldo inicial positivo",
      );
    }

    const idempotencyKey = `opening:${props.walletId}`;

    return new WagerTransaction({
      id: props.id,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: props.walletId,
      idempotencyKey,
      payloadHash: openingPayloadHash(props, idempotencyKey),
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: OPENING_ROUND_AND_GAME_ID,
      gameId: OPENING_ROUND_AND_GAME_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Processed,
      balanceAfter: props.money,
      processedAt: props.createdAt,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  markPendingReference(nextAttemptAt: Date): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._nextAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, balanceAfter: Money, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._balanceAfter = balanceAfter;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return ALLOWED_TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  hasReference(): boolean {
    return Boolean(this.referenceExternalTransactionId);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        return this.inverseDirectionOf(reference);
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError(
          "WAGER_NO_LEDGER_ENTRY",
          "LOSS não movimenta saldo e não gera lançamento",
        );
    }
  }

  insufficientFundsFailureCode(): FailureCode {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return FailureCode.InsufficientFunds;
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        return FailureCode.ReversalInsufficientFunds;
      default:
        throw new InvalidWagerTransactionError(
          "WAGER_NO_LEDGER_ENTRY",
          `${this.kind} não gera débito`,
        );
    }
  }

  private inverseDirectionOf(reference: WagerTransaction | undefined): LedgerDirection {
    if (!reference) {
      throw new InvalidWagerTransactionError(
        "WAGER_REFERENCE_REQUIRED",
        "ROLLBACK precisa da transação referenciada para inverter o lançamento",
      );
    }

    switch (reference.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Debit;
      default:
        throw new InvalidWagerTransactionError(
          "WAGER_INVALID_REFERENCE_KIND",
          `ROLLBACK não pode reverter ${reference.kind}`,
        );
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!ALLOWED_TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this._status, next);
    }

    this._status = next;
  }
}
