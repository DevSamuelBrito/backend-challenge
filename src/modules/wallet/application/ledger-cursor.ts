import { InvalidRequestError } from "../../../shared/application/invalid-request-error";

const TOKEN_PREFIX = "l1:";
const TOKEN_PATTERN = /^l1:([1-9]\d*)$/;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

export function encodeLedgerCursor(seq: string): string {
  return Buffer.from(`${TOKEN_PREFIX}${seq}`, "utf8").toString("base64url");
}

export function decodeLedgerCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = TOKEN_PATTERN.exec(decoded);
  const seq = match?.[1];

  if (seq === undefined || BigInt(seq) > MAX_BIGINT || encodeLedgerCursor(seq) !== cursor) {
    throw new InvalidRequestError("cursor inválido");
  }

  return seq;
}
