import { DomainError } from "../../../shared/domain/domain-error";

export class InboxMessageAlreadyProcessedError extends DomainError {
  readonly code = "INBOX_MESSAGE_ALREADY_PROCESSED";

  constructor(consumerName: string, messageId: string) {
    super(`Mensagem ${messageId} do consumidor ${consumerName} já foi processada`);
  }
}

export class OutboxMessageAlreadyPublishedError extends DomainError {
  readonly code = "OUTBOX_MESSAGE_ALREADY_PUBLISHED";

  constructor(id: string) {
    super(`Mensagem ${id} da outbox já foi publicada`);
  }
}
