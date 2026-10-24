import { EntitySchema } from "@mikro-orm/core";

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string" },
    currency: { type: "string", columnType: "char(3)" },
    balance: { type: "string", columnType: "numeric(20,2)" },
    version: { type: "number", columnType: "integer" },
    createdAt: { type: "Date", columnType: "timestamptz" },
    updatedAt: { type: "Date", columnType: "timestamptz" },
  },
});
