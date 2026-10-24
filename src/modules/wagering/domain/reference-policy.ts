import { FailureCode } from "./failure-code";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction";

export interface ReferenceLookup {
  reference: WagerTransaction | undefined;
  alreadyReversed: boolean;
}

export type ReferenceDecision =
  | {
      status: WagerTransactionStatus.Processed;
      referenceTransactionId: string | undefined;
    }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

const ALLOWED_REFERENCE_KINDS: Partial<
  Record<WagerTransactionKind, readonly WagerTransactionKind[]>
> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
};

const rejected = (failureCode: FailureCode): ReferenceDecision => ({
  status: WagerTransactionStatus.Rejected,
  failureCode,
});

export function evaluateReference(
  transaction: WagerTransaction,
  lookup: ReferenceLookup,
): ReferenceDecision {
  const allowedKinds = ALLOWED_REFERENCE_KINDS[transaction.kind];
  const usesReference = transaction.requiresReference() || transaction.hasReference();

  if (!allowedKinds || !usesReference) {
    return { status: WagerTransactionStatus.Processed, referenceTransactionId: undefined };
  }

  const { reference, alreadyReversed } = lookup;

  if (!reference) {
    return { status: WagerTransactionStatus.PendingReference };
  }

  if (!allowedKinds.includes(reference.kind)) {
    return rejected(FailureCode.ReferenceKindNotAllowed);
  }

  if (reference.walletId !== transaction.walletId) {
    return rejected(FailureCode.ReferenceWalletMismatch);
  }

  if (reference.playerId !== transaction.playerId) {
    return rejected(FailureCode.ReferencePlayerMismatch);
  }

  if (reference.money.currency !== transaction.money.currency) {
    return rejected(FailureCode.ReferenceCurrencyMismatch);
  }

  if (reference.roundId !== transaction.roundId) {
    return rejected(FailureCode.ReferenceRoundMismatch);
  }

  if (transaction.requiresReference() && !reference.money.equals(transaction.money)) {
    return rejected(FailureCode.ReferenceAmountMismatch);
  }

  if (
    reference.status === WagerTransactionStatus.Rejected ||
    reference.status === WagerTransactionStatus.Failed
  ) {
    return rejected(FailureCode.ReferenceNotProcessed);
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    return { status: WagerTransactionStatus.PendingReference };
  }

  if (transaction.requiresReference() && alreadyReversed) {
    return rejected(FailureCode.ReferenceAlreadyReversed);
  }

  return { status: WagerTransactionStatus.Processed, referenceTransactionId: reference.id };
}
