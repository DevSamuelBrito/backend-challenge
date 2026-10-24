import type { MoneyProps } from "../../../../shared/domain/money";
import type { WagerTransaction, WagerTransactionKind } from "../wager-transaction";

export interface WagerEventBaseData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function baseDataOf(transaction: WagerTransaction): WagerEventBaseData {
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
    ...(transaction.referenceExternalTransactionId && {
      referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    }),
  };
}
