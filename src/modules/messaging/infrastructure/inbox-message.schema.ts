import { EntitySchema } from "@mikro-orm/core";

export interface InboxMessageRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  name: "InboxMessageRecord",
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: { type: "string" },
    receivedAt: { type: "Date", columnType: "timestamptz" },
    processedAt: { type: "Date", columnType: "timestamptz", nullable: true },
  },
});
