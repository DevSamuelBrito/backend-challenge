import { InvalidRequestError } from "./invalid-request-error";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidRequestError(`${field} deve ser um UUID`);
  }

  return value;
}
