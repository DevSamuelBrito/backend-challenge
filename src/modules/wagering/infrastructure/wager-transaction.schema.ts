import { EntitySchema } from "@mikro-orm/core";

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  balanceAfterAmount: string | null;
  referenceAttempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: "WagerTransactionRecord",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string" },
    walletId: { type: "uuid" },
    playerId: { type: "string" },
    roundId: { type: "string" },
    gameId: { type: "string" },
    kind: { type: "string" },
    amount: { type: "string", columnType: "numeric(20,2)" },
    currency: { type: "string", columnType: "char(3)" },
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", nullable: true },
    balanceAfterAmount: { type: "string", columnType: "numeric(20,2)", nullable: true },
    referenceAttempts: { type: "number", columnType: "integer" },
    nextAttemptAt: { type: "Date", columnType: "timestamptz", nullable: true },
    createdAt: { type: "Date", columnType: "timestamptz" },
    processedAt: { type: "Date", columnType: "timestamptz", nullable: true },
  },
});
