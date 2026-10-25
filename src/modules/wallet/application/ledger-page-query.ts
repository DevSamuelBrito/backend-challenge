import { InvalidRequestError } from "../../../shared/application/invalid-request-error";
import { decodeLedgerCursor } from "./ledger-cursor";

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export interface LedgerPageQuery {
  afterSeq: string | undefined;
  limit: number;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return DEFAULT_LEDGER_LIMIT;
  }

  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new InvalidRequestError(`limit deve ser um inteiro entre 1 e ${MAX_LEDGER_LIMIT}`);
  }

  const limit = Number(raw);

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
    throw new InvalidRequestError(`limit deve ser um inteiro entre 1 e ${MAX_LEDGER_LIMIT}`);
  }

  return limit;
}

function parseCursor(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== "string") {
    throw new InvalidRequestError("cursor inválido");
  }

  return decodeLedgerCursor(raw);
}

export function parseLedgerPageQuery(input: { cursor: unknown; limit: unknown }): LedgerPageQuery {
  return { afterSeq: parseCursor(input.cursor), limit: parseLimit(input.limit) };
}
