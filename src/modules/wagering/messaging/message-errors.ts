import { DomainError } from "../../../shared/domain/domain-error";

export class MalformedMessageError extends DomainError {
  readonly code = "MALFORMED_MESSAGE";
}

export class UnexpectedMessageTypeError extends DomainError {
  readonly code = "UNEXPECTED_MESSAGE_TYPE";

  constructor(type: unknown) {
    super(`Tipo de mensagem não suportado: ${String(type)}`);
  }
}
