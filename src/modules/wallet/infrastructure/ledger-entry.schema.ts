import { EntitySchema } from "@mikro-orm/core";

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: "LedgerEntryRecord",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    direction: { type: "string" },
    amount: { type: "string", columnType: "numeric(20,2)" },
    currency: { type: "string", columnType: "char(3)" },
    balanceBefore: { type: "string", columnType: "numeric(20,2)" },
    balanceAfter: { type: "string", columnType: "numeric(20,2)" },
    walletVersion: { type: "number", columnType: "integer" },
    createdAt: { type: "Date", columnType: "timestamptz" },
  },
});
