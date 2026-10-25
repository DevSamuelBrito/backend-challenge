import type { EntityManager } from "@mikro-orm/postgresql";
import { AggregateNotFoundError } from "../../../shared/application/persistence-errors";
import type { OutboxRepository } from "../application/outbox.repository";
import type { OutboxMessage } from "../domain/outbox-message";
import { outboxMessageMapper } from "./outbox-message.mapper";
import { type OutboxMessageRecord, OutboxMessageSchema } from "./outbox-message.schema";

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageSchema, outboxMessageMapper.toRecord(message));
  }

  async lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.execute<OutboxRow[]>(
      `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
         from outbox_messages
        where published_at is null and next_attempt_at <= ?
        order by seq
        limit ?
          for update skip locked`,
      [now, limit],
    );

    return rows.map((row) => outboxMessageMapper.toDomain(toRecord(row)));
  }

  async save(message: OutboxMessage): Promise<void> {
    const { attempts, nextAttemptAt, publishedAt } = outboxMessageMapper.toRecord(message);

    const updated = await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id },
      { attempts, nextAttemptAt, publishedAt },
    );

    if (updated === 0) {
      throw new AggregateNotFoundError("OutboxMessage", message.id);
    }
  }
}

function toRecord(row: OutboxRow): OutboxMessageRecord {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    publishedAt: row.published_at,
  };
}
