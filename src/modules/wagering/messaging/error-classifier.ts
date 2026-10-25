import { LockTimeoutError } from "../../../shared/application/persistence-errors";
import { DomainError } from "../../../shared/domain/domain-error";
import { InboxPayloadMismatchError } from "../../messaging/domain/messaging-errors";
import { WalletNotFoundError } from "../../wallet/domain/wallet-errors";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from "../domain/wager-transaction-errors";
import { MalformedMessageError, UnexpectedMessageTypeError } from "./message-errors";

export type PermanentReason =
  | "MALFORMED_MESSAGE"
  | "UNEXPECTED_MESSAGE_TYPE"
  | "INVALID_PAYLOAD"
  | "WALLET_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "EXTERNAL_TRANSACTION_CONFLICT"
  | "INBOX_PAYLOAD_MISMATCH";

export type TransientReason = "LOCK_TIMEOUT" | "DATABASE_UNAVAILABLE" | "UNEXPECTED_ERROR";

export type ErrorClassification =
  | { kind: "permanent"; reason: PermanentReason }
  | { kind: "transient"; reason: TransientReason };

interface Rule {
  matches: (error: unknown) => boolean;
  classification: ErrorClassification;
}

const permanent = (reason: PermanentReason): ErrorClassification => ({ kind: "permanent", reason });
const transient = (reason: TransientReason): ErrorClassification => ({ kind: "transient", reason });

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "55000",
]);

function codeOf(error: unknown): string | undefined {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

  return typeof code === "string" ? code : undefined;
}

function isConnectionError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    const code = codeOf(current);

    if (code !== undefined && (CONNECTION_ERROR_CODES.has(code) || code.startsWith("08"))) {
      return true;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Tabela de classificação. A primeira regra que casa vence, então as específicas vêm antes das
 * genéricas. O que não casa com nenhuma é tratado como transitório: na dúvida, a mensagem tenta
 * de novo e, se nunca der certo, o redrive do SQS a leva para a DLQ.
 */
const RULES: readonly Rule[] = [
  { matches: (e) => e instanceof LockTimeoutError, classification: transient("LOCK_TIMEOUT") },
  { matches: isConnectionError, classification: transient("DATABASE_UNAVAILABLE") },
  {
    matches: (e) => e instanceof MalformedMessageError,
    classification: permanent("MALFORMED_MESSAGE"),
  },
  {
    matches: (e) => e instanceof UnexpectedMessageTypeError,
    classification: permanent("UNEXPECTED_MESSAGE_TYPE"),
  },
  {
    matches: (e) => e instanceof InboxPayloadMismatchError,
    classification: permanent("INBOX_PAYLOAD_MISMATCH"),
  },
  {
    matches: (e) => e instanceof WalletNotFoundError,
    classification: permanent("WALLET_NOT_FOUND"),
  },
  {
    matches: (e) => e instanceof IdempotencyConflictError,
    classification: permanent("IDEMPOTENCY_CONFLICT"),
  },
  {
    matches: (e) => e instanceof ExternalTransactionConflictError,
    classification: permanent("EXTERNAL_TRANSACTION_CONFLICT"),
  },
  { matches: (e) => e instanceof DomainError, classification: permanent("INVALID_PAYLOAD") },
];

const UNKNOWN_ERROR = transient("UNEXPECTED_ERROR");

export function classifyError(error: unknown): ErrorClassification {
  return RULES.find((rule) => rule.matches(error))?.classification ?? UNKNOWN_ERROR;
}
