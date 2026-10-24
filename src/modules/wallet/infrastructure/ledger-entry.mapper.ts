import {
  moneyFromColumn,
  moneyToColumn,
  parseEnum,
} from "../../../shared/infrastructure/database/mapping";
import { LedgerDirection } from "../domain/ledger-direction";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import type { LedgerEntryRecord } from "./ledger-entry.schema";

export const ledgerEntryMapper = {
  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: moneyToColumn(entry.money),
      currency: entry.money.currency,
      balanceBefore: moneyToColumn(entry.balanceBefore),
      balanceAfter: moneyToColumn(entry.balanceAfter),
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    };
  },

  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: parseEnum(LedgerDirection, "wallet_ledger_entries.direction", record.direction),
      money: moneyFromColumn(record.amount, record.currency),
      balanceBefore: moneyFromColumn(record.balanceBefore, record.currency),
      balanceAfter: moneyFromColumn(record.balanceAfter, record.currency),
      walletVersion: record.walletVersion,
      createdAt: record.createdAt,
    });
  },
};
