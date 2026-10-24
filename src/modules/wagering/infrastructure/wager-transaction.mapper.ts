import {
  moneyFromColumn,
  moneyToColumn,
  parseEnum,
} from "../../../shared/infrastructure/database/mapping";
import { FailureCode } from "../domain/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import type { WagerTransactionRecord } from "./wager-transaction.schema";

export const wagerTransactionMapper = {
  toRecord(transaction: WagerTransaction): WagerTransactionRecord {
    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: moneyToColumn(transaction.money),
      currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      status: transaction.status,
      failureCode: transaction.failureCode ?? null,
      balanceAfterAmount: transaction.balanceAfter ? moneyToColumn(transaction.balanceAfter) : null,
      referenceAttempts: transaction.referenceAttempts,
      nextAttemptAt: transaction.nextAttemptAt ?? null,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt ?? null,
    };
  },

  toDomain(record: WagerTransactionRecord, walletCurrency: string): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: parseEnum(WagerTransactionKind, "wager_transactions.kind", record.kind),
      money: moneyFromColumn(record.amount, record.currency),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      createdAt: record.createdAt,
      status: parseEnum(WagerTransactionStatus, "wager_transactions.status", record.status),
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      failureCode:
        record.failureCode === null
          ? undefined
          : parseEnum(FailureCode, "wager_transactions.failure_code", record.failureCode),
      balanceAfter:
        record.balanceAfterAmount === null
          ? undefined
          : moneyFromColumn(record.balanceAfterAmount, walletCurrency),
      processedAt: record.processedAt ?? undefined,
      referenceAttempts: record.referenceAttempts,
      nextAttemptAt: record.nextAttemptAt ?? undefined,
    });
  },
};
