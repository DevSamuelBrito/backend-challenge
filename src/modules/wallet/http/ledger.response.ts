import type { MoneyProps } from "../../../shared/domain/money";
import type { LedgerPage } from "../application/get-wallet-ledger";
import type { WalletReconciliation } from "../application/reconcile-wallet";

export interface LedgerItemResponse {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageResponse {
  items: LedgerItemResponse[];
  nextCursor: string | null;
}

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export function toLedgerPageResponse(page: LedgerPage): LedgerPageResponse {
  return {
    items: page.entries.map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

export function toReconciliationResponse(result: WalletReconciliation): ReconciliationResponse {
  return {
    walletId: result.walletId,
    storedBalance: result.storedBalance.toJSON(),
    calculatedBalance: result.calculatedBalance.toJSON(),
    difference: result.difference.toJSON(),
    consistent: result.consistent,
    checkedEntries: result.checkedEntries,
  };
}
