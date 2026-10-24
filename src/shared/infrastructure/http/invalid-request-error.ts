import { DomainError } from "../../domain/domain-error";

export class InvalidRequestError extends DomainError {
  readonly code = "INVALID_REQUEST";
}
