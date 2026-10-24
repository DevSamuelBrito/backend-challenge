import { Money, type MoneyProps } from "../../../shared/domain/money";
import { InvalidRequestError } from "../../../shared/infrastructure/http/invalid-request-error";
import type { OpenWalletCommand } from "../application/open-wallet";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOpenWalletRequest(body: unknown): OpenWalletCommand {
  if (!isRecord(body)) {
    throw new InvalidRequestError("O corpo da requisição deve ser um objeto JSON");
  }

  const { playerId, initialBalance } = body;

  if (typeof playerId !== "string" || playerId.trim() === "") {
    throw new InvalidRequestError("playerId deve ser uma string não vazia");
  }

  if (!isRecord(initialBalance)) {
    throw new InvalidRequestError("initialBalance é obrigatório e deve ter amount e currency");
  }

  return {
    playerId,
    initialBalance: Money.from(initialBalance as unknown as MoneyProps),
  };
}
