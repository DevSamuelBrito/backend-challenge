import type { InboxMessage } from "../domain/inbox-message";

export interface InboxReceipt {
  isNew: boolean;
  storedPayloadHash: string;
}

export interface InboxRepository {
  tryReceive(message: InboxMessage): Promise<InboxReceipt>;
}
