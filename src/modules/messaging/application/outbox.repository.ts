import type { OutboxMessage } from "../domain/outbox-message";

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
}
