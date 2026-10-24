import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { HttpClient, HttpResult } from "./http";

export interface OpenedWallet {
  id: string;
  playerId: string;
  currency: string;
}

export async function openWallet(
  http: HttpClient,
  balance = "100.00",
  currency = "BRL",
  playerId = `player-${randomUUID()}`,
): Promise<OpenedWallet> {
  const response = await http.post("/wallets", {
    playerId,
    initialBalance: { amount: balance, currency },
  });

  if (response.status !== 201) {
    throw new Error(`falha ao abrir wallet: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return { id: (response.body as { id: string }).id, playerId, currency };
}

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wagerPayload(
  wallet: OpenedWallet,
  overrides: Partial<WagerPayload> = {},
): WagerPayload {
  return {
    providerId: "provider-a",
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "game-1",
    kind: "BET",
    money: { amount: "10.00", currency: wallet.currency },
    ...overrides,
  };
}

export const keyFor = (payload: Pick<WagerPayload, "providerId" | "externalTransactionId">) =>
  `${payload.providerId}:${payload.externalTransactionId}`;

export function submit(
  http: HttpClient,
  payload: unknown,
  idempotencyKey?: string,
): Promise<HttpResult> {
  const headers: Record<string, string> =
    idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey };

  return http.post("/wagering/transactions", payload, headers);
}

export function submitWithDefaultKey(http: HttpClient, payload: WagerPayload): Promise<HttpResult> {
  return submit(http, payload, keyFor(payload));
}

export interface WalletSnapshot {
  balance: string;
  version: number;
}

export async function walletSnapshot(client: Client, walletId: string): Promise<WalletSnapshot> {
  const { rows } = await client.query(
    "select balance::text as balance, version from wallets where id = $1",
    [walletId],
  );

  return rows[0] as WalletSnapshot;
}

export async function ledgerOf(client: Client, walletId: string) {
  const { rows } = await client.query(
    `select transaction_id, direction, amount::text as amount, balance_before::text as balance_before,
            balance_after::text as balance_after, wallet_version
       from wallet_ledger_entries where wallet_id = $1 order by wallet_version`,
    [walletId],
  );

  return rows as {
    transaction_id: string;
    direction: string;
    amount: string;
    balance_before: string;
    balance_after: string;
    wallet_version: number;
  }[];
}

export async function transactionsOf(client: Client, walletId: string) {
  const { rows } = await client.query(
    `select id, kind, status, failure_code, amount::text as amount, currency,
            balance_after_amount::text as balance_after_amount, idempotency_key, payload_hash,
            provider_id, external_transaction_id
       from wager_transactions where wallet_id = $1 and kind <> 'OPENING' order by created_at, id`,
    [walletId],
  );

  return rows as Record<string, unknown>[];
}

export async function eventsOfTransaction(client: Client, transactionId: string) {
  const { rows } = await client.query(
    `select event_type, payload from outbox_messages
      where payload -> 'data' ->> 'transactionId' = $1
      order by seq`,
    [transactionId],
  );

  return rows as {
    event_type: string;
    payload: { causationId: string; data: Record<string, unknown> };
  }[];
}
