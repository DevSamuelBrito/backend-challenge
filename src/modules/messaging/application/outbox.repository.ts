import type { OutboxMessage } from "../domain/outbox-message";

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
}
