import type { MoneyProps } from "../../../shared/domain/money";
import type { FailureCode } from "../domain/failure-code";
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";

export interface WagerTransactionDetailResponse {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  referenceExternalTransactionId?: string;
  createdAt: string;
  processedAt?: string;
}

export function toWagerTransactionDetailResponse(
  transaction: WagerTransaction,
): WagerTransactionDetailResponse {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    ...(transaction.balanceAfter && { balance: transaction.balanceAfter.toJSON() }),
    ...(transaction.failureCode && { failureCode: transaction.failureCode }),
    ...(transaction.referenceExternalTransactionId && {
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    }),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt && { processedAt: transaction.processedAt.toISOString() }),
  };
}
