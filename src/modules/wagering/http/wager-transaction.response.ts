import type { MoneyProps } from "../../../shared/domain/money";
import type { ProcessWagerTransactionResult } from "../application/process-wager-transaction";
import type { FailureCode } from "../domain/failure-code";
import { WagerTransactionStatus } from "../domain/wager-transaction";

export interface WagerTransactionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

export function toWagerTransactionResponse(
  result: ProcessWagerTransactionResult,
): WagerTransactionResponse {
  return {
    transactionId: result.transactionId,
    status: result.status,
    ...(result.failureCode && { failureCode: result.failureCode }),
    balance: result.balance.toJSON(),
    idempotentReplay: result.idempotentReplay,
  };
}

export function httpStatusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
  }
}
