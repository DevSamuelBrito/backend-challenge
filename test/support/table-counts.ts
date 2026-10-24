import type { Client } from "pg";

const TABLES = [
  "wallets",
  "wager_transactions",
  "wallet_ledger_entries",
  "inbox_messages",
  "outbox_messages",
] as const;

export type TableCounts = Record<(typeof TABLES)[number], number>;

export async function tableCounts(client: Client): Promise<TableCounts> {
  const counts = {} as TableCounts;

  for (const table of TABLES) {
    const { rows } = await client.query(`select count(*)::int as total from ${table}`);
    counts[table] = rows[0].total as number;
  }

  return counts;
}

export const EMPTY_COUNTS: TableCounts = {
  wallets: 0,
  wager_transactions: 0,
  wallet_ledger_entries: 0,
  inbox_messages: 0,
  outbox_messages: 0,
};
