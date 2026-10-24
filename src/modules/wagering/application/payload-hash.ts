import { createHash } from "node:crypto";
import { canonicalJson } from "../../../shared/application/canonical-json";
import type { ProcessWagerTransactionCommand } from "./process-wager-transaction.command";

export function computePayloadHash(command: ProcessWagerTransactionCommand): string {
  const canonical = canonicalJson({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money.toJSON(),
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });

  return createHash("sha256").update(canonical).digest("hex");
}
