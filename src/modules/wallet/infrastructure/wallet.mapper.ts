import { moneyFromColumn, moneyToColumn } from "../../../shared/infrastructure/database/mapping";
import { Wallet } from "../domain/wallet";
import type { WalletRecord } from "./wallet.schema";

export const walletMapper = {
  toRecord(wallet: Wallet): WalletRecord {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: moneyToColumn(wallet.balance),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },

  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: moneyFromColumn(record.balance, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },
};
