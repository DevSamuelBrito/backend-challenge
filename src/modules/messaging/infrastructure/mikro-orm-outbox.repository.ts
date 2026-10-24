import type { EntityManager } from "@mikro-orm/core";
import type { OutboxRepository } from "../application/outbox.repository";
import type { OutboxMessage } from "../domain/outbox-message";
import { outboxMessageMapper } from "./outbox-message.mapper";
import { OutboxMessageSchema } from "./outbox-message.schema";

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageSchema, outboxMessageMapper.toRecord(message));
  }
}
