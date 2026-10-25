import { ConflictError, DomainError } from "../../../shared/domain/domain-error";

export class InboxPayloadMismatchError extends ConflictError {
  readonly code = "INBOX_PAYLOAD_MISMATCH";

  constructor(consumerName: string, messageId: string) {
    super(
      `A mensagem ${messageId} do consumidor ${consumerName} já foi recebida com um conteúdo diferente`,
    );
  }
}

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
