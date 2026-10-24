import type { Money } from "../../../shared/domain/money";
import { LedgerDirection } from "./ledger-direction";
import { InvalidLedgerEntryError } from "./wallet-errors";

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

function isArithmeticBalanced(
  direction: LedgerDirection,
  money: Money,
  balanceBefore: Money,
  balanceAfter: Money,
): boolean {
  if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
    return false;
  }

  return direction === LedgerDirection.Credit
    ? balanceAfter.subtract(balanceBefore).equals(money)
    : balanceBefore.subtract(balanceAfter).equals(money);
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter, direction, walletVersion } = props;

    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError("Lançamento deve ter valor positivo");
    }

    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError("Lançamento com moedas diferentes");
    }

    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("Lançamento não pode deixar nem partir de saldo negativo");
    }

    if (!Number.isInteger(walletVersion) || walletVersion < 1) {
      throw new InvalidLedgerEntryError(`Versão da wallet inválida: ${walletVersion}`);
    }

    if (!isArithmeticBalanced(direction, money, balanceBefore, balanceAfter)) {
      throw new InvalidLedgerEntryError(
        `Aritmética do lançamento não confere para ${direction}: saldo anterior ± valor ≠ saldo posterior`,
      );
    }

    return WalletLedgerEntry.rehydrate(props);
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    return isArithmeticBalanced(this.direction, this.money, this.balanceBefore, this.balanceAfter);
  }
}
