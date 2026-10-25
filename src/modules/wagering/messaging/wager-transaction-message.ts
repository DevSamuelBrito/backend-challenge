import { InvalidRequestError } from "../../../shared/application/invalid-request-error";
import {
  type ProcessWagerTransactionCommand,
  parseProcessWagerTransactionCommand,
} from "../application/process-wager-transaction.command";
import { MalformedMessageError, UnexpectedMessageTypeError } from "./message-errors";

export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";
export const WAGER_TRANSACTION_CONSUMER = "wager-transaction-consumer";

const MAX_MESSAGE_ID_LENGTH = 255;

export interface WagerTransactionMessage {
  messageId: string;
  command: ProcessWagerTransactionCommand;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessageId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_MESSAGE_ID_LENGTH) {
    throw new InvalidRequestError(
      `messageId deve ser uma string não vazia de até ${MAX_MESSAGE_ID_LENGTH} caracteres`,
    );
  }

  return value;
}

export function parseWagerTransactionMessage(body: string): WagerTransactionMessage {
  let raw: unknown;

  try {
    raw = JSON.parse(body);
  } catch {
    throw new MalformedMessageError("O corpo da mensagem não é um JSON válido");
  }

  if (!isRecord(raw)) {
    throw new MalformedMessageError("O corpo da mensagem deve ser um objeto JSON");
  }

  if (raw.type !== WAGER_TRANSACTION_REQUESTED) {
    throw new UnexpectedMessageTypeError(raw.type);
  }

  const messageId = parseMessageId(raw.messageId);
  const { data } = raw;

  if (!isRecord(data)) {
    throw new InvalidRequestError("data é obrigatório e deve ser um objeto");
  }

  if (typeof data.idempotencyKey !== "string") {
    throw new InvalidRequestError("data.idempotencyKey é obrigatório e deve ser uma string");
  }

  return {
    messageId,
    command: parseProcessWagerTransactionCommand({
      idempotencyKey: data.idempotencyKey,
      payload: data,
    }),
  };
}
