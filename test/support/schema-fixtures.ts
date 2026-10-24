import { randomUUID } from "node:crypto";
import type { Client, QueryResultRow } from "pg";

export type Row = Record<string, unknown>;

export async function insertRow(client: Client, table: string, row: Row): Promise<QueryResultRow> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);

  const result = await client.query(
    `insert into ${table} (${columns.join(", ")}) values (${placeholders.join(", ")}) returning *`,
    Object.values(row),
  );

  return result.rows[0] as QueryResultRow;
}

const NOW = new Date("2026-01-01T12:00:00.000Z");

export function walletRow(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    player_id: `player-${randomUUID()}`,
    currency: "BRL",
    balance: "100.00",
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function transactionRow(walletId: string, overrides: Row = {}): Row {
  const unique = randomUUID();

  return {
    id: randomUUID(),
    provider_id: "provider-a",
    external_transaction_id: `ext-${unique}`,
    idempotency_key: `key-${unique}`,
    payload_hash: "hash",
    wallet_id: walletId,
    player_id: "player-1",
    round_id: "round-1",
    game_id: "game-1",
    kind: "BET",
    amount: "25.00",
    currency: "BRL",
    status: "PENDING",
    created_at: NOW,
    ...overrides,
  };
}

export function ledgerRow(walletId: string, transactionId: string, overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: "DEBIT",
    amount: "80.00",
    currency: "BRL",
    balance_before: "100.00",
    balance_after: "20.00",
    wallet_version: 2,
    created_at: NOW,
    ...overrides,
  };
}

export function inboxRow(overrides: Row = {}): Row {
  return {
    consumer_name: "wager-transactions",
    message_id: `msg-${randomUUID()}`,
    payload_hash: "hash",
    received_at: NOW,
    ...overrides,
  };
}

export function outboxRow(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    aggregate_id: randomUUID(),
    event_type: "WalletBalanceChanged",
    payload: { eventType: "WalletBalanceChanged" },
    occurred_at: NOW,
    next_attempt_at: NOW,
    ...overrides,
  };
}

export async function seedWallet(client: Client, overrides: Row = {}): Promise<{ id: string }> {
  const row = await insertRow(client, "wallets", walletRow(overrides));
  return { id: row.id as string };
}

export async function seedTransaction(
  client: Client,
  walletId: string,
  overrides: Row = {},
): Promise<{ id: string; externalId: string }> {
  const row = await insertRow(client, "wager_transactions", transactionRow(walletId, overrides));
  return { id: row.id as string, externalId: row.external_transaction_id as string };
}
