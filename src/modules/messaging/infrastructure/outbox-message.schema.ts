import { EntitySchema } from "@mikro-orm/core";

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: "OutboxMessageRecord",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "string" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: { type: "Date", columnType: "timestamptz" },
    attempts: { type: "number", columnType: "integer" },
    nextAttemptAt: { type: "Date", columnType: "timestamptz" },
    publishedAt: { type: "Date", columnType: "timestamptz", nullable: true },
  },
});
