import { CurrencyMismatchError, type Money } from "../../../shared/domain/money";
import { LedgerDirection } from "./ledger-direction";
import { InsufficientFundsError, InvalidWalletError } from "./wallet-errors";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError("WALLET_INVALID_BALANCE", "Saldo inicial não pode ser negativo");
    }

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);

    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(this.id);
    }

    return this.apply(LedgerDirection.Debit, props, this._balance.subtract(props.money));
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);

    return this.apply(LedgerDirection.Credit, props, this._balance.add(props.money));
  }

  private apply(
    direction: LedgerDirection,
    props: MovementProps,
    balanceAfter: Money,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: props.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.at;

    return entry;
  }

  private assertMovement(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }

    if (!money.isPositive()) {
      throw new InvalidWalletError(
        "WALLET_INVALID_MOVEMENT_AMOUNT",
        "Movimentação deve ter valor positivo",
      );
    }
  }
}
