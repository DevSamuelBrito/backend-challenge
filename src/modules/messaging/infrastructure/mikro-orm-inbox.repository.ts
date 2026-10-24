import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxReceipt, InboxRepository } from "../application/inbox.repository";
import type { InboxMessage } from "../domain/inbox-message";
import { inboxMessageMapper } from "./inbox-message.mapper";

const INSERT_IGNORING_DUPLICATES = `
  insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
  values (?, ?, ?, ?, ?)
  on conflict (consumer_name, message_id) do nothing
  returning payload_hash
`;

const SELECT_STORED = `
  select payload_hash from inbox_messages where consumer_name = ? and message_id = ?
`;

interface PayloadHashRow {
  payload_hash: string;
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<InboxReceipt> {
    const record = inboxMessageMapper.toRecord(message);

    const inserted = await this.em.execute<PayloadHashRow[]>(INSERT_IGNORING_DUPLICATES, [
      record.consumerName,
      record.messageId,
      record.payloadHash,
      record.receivedAt,
      record.processedAt,
    ]);

    if (inserted[0]) {
      return { isNew: true, storedPayloadHash: inserted[0].payload_hash };
    }

    const stored = await this.em.execute<PayloadHashRow[]>(SELECT_STORED, [
      record.consumerName,
      record.messageId,
    ]);

    if (!stored[0]) {
      throw new Error(
        `Mensagem ${record.consumerName}/${record.messageId} conflitou no insert mas não foi encontrada`,
      );
    }

    return { isNew: false, storedPayloadHash: stored[0].payload_hash };
  }
}
