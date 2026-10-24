import { InvalidRequestError } from "../../../shared/application/invalid-request-error";
import { parseUuid } from "../../../shared/application/parse-uuid";
import { InvalidMoneyError, Money, type MoneyProps } from "../../../shared/domain/money";
import { WagerTransactionKind } from "../domain/wager-transaction";

const MAX_TEXT_LENGTH = 255;

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface RawProcessWagerTransactionInput {
  idempotencyKey: unknown;
  payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidRequestError(`${field} deve ser uma string não vazia`);
  }

  if (value.length > MAX_TEXT_LENGTH) {
    throw new InvalidRequestError(`${field} deve ter no máximo ${MAX_TEXT_LENGTH} caracteres`);
  }

  return value;
}

function parseKind(value: unknown): WagerTransactionKind {
  const kind = Object.values(WagerTransactionKind).find((candidate) => candidate === value);

  if (kind === undefined) {
    throw new InvalidRequestError(
      `kind deve ser um de ${Object.values(WagerTransactionKind)
        .filter((candidate) => candidate !== WagerTransactionKind.Opening)
        .join(", ")}`,
    );
  }

  if (kind === WagerTransactionKind.Opening) {
    throw new InvalidRequestError("OPENING é interno e não pode ser enviado por esta API");
  }

  return kind;
}

function parseMoney(value: unknown): Money {
  if (!isRecord(value)) {
    throw new InvalidRequestError("money é obrigatório e deve ter amount e currency");
  }

  const money = Money.from(value as unknown as MoneyProps);

  if (!money.isPositive()) {
    throw new InvalidMoneyError("O valor da transação deve ser maior que zero");
  }

  return money;
}

function parseReference(value: unknown, kind: WagerTransactionKind): string | undefined {
  const present = value !== undefined && value !== null;
  const requiresReference =
    kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;

  if (!present) {
    if (requiresReference) {
      throw new InvalidRequestError(`${kind} exige referenceExternalTransactionId`);
    }

    return undefined;
  }

  if (kind === WagerTransactionKind.Bet) {
    throw new InvalidRequestError("BET não aceita referenceExternalTransactionId");
  }

  return requiredText(value, "referenceExternalTransactionId");
}

export function parseProcessWagerTransactionCommand(
  input: RawProcessWagerTransactionInput,
): ProcessWagerTransactionCommand {
  const { idempotencyKey, payload } = input;

  if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
    throw new InvalidRequestError("O header Idempotency-Key é obrigatório e não pode ser vazio");
  }

  if (idempotencyKey.length > MAX_TEXT_LENGTH) {
    throw new InvalidRequestError(
      `O header Idempotency-Key deve ter no máximo ${MAX_TEXT_LENGTH} caracteres`,
    );
  }

  if (!isRecord(payload)) {
    throw new InvalidRequestError("O corpo da requisição deve ser um objeto JSON");
  }

  const kind = parseKind(payload.kind);
  const referenceExternalTransactionId = parseReference(
    payload.referenceExternalTransactionId,
    kind,
  );

  return {
    idempotencyKey,
    providerId: requiredText(payload.providerId, "providerId"),
    externalTransactionId: requiredText(payload.externalTransactionId, "externalTransactionId"),
    playerId: requiredText(payload.playerId, "playerId"),
    walletId: parseUuid(requiredText(payload.walletId, "walletId"), "walletId"),
    roundId: requiredText(payload.roundId, "roundId"),
    gameId: requiredText(payload.gameId, "gameId"),
    kind,
    money: parseMoney(payload.money),
    ...(referenceExternalTransactionId !== undefined && { referenceExternalTransactionId }),
  };
}
