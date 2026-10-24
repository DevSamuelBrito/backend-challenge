import { expect } from "bun:test";
import type { Client } from "pg";

interface Check {
  description: string;
  sql: string;
  format: (row: Record<string, unknown>) => string;
}

const SIGNED_LEDGER_SUM = `coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`;

const CHECKS: Check[] = [
  {
    description: "wallet.balance == Σ(CREDIT) − Σ(DEBIT) do ledger",
    sql: `select w.id, w.balance::text as balance, ${SIGNED_LEDGER_SUM}::text as ledger_sum
            from wallets w
            left join wallet_ledger_entries l on l.wallet_id = w.id
           group by w.id, w.balance
          having w.balance <> ${SIGNED_LEDGER_SUM}`,
    format: (row) =>
      `wallet ${row.id}: saldo ${row.balance} difere da soma do ledger ${row.ledger_sum}`,
  },
  {
    description: "último balance_after do ledger == wallet.balance",
    sql: `select w.id, w.balance::text as balance, last.balance_after::text as last_balance_after
            from wallets w
            join lateral (
              select balance_after from wallet_ledger_entries
               where wallet_id = w.id
               order by wallet_version desc
               limit 1
            ) last on true
           where last.balance_after <> w.balance`,
    format: (row) =>
      `wallet ${row.id}: saldo ${row.balance} difere do último balance_after ${row.last_balance_after}`,
  },
  {
    description: "wallet_version contíguo e igual ao da wallet",
    sql: `select w.id, w.version, e.first_version, e.last_version, e.entries
            from wallets w
            join (
              select wallet_id,
                     min(wallet_version) as first_version,
                     max(wallet_version) as last_version,
                     count(*) as entries
                from wallet_ledger_entries
               group by wallet_id
            ) e on e.wallet_id = w.id
           where e.last_version <> w.version
              or e.entries <> e.last_version - e.first_version + 1
              or e.first_version > 2`,
    format: (row) =>
      `wallet ${row.id}: version ${row.version}, ledger com ${row.entries} lançamentos de ${row.first_version} a ${row.last_version}`,
  },
  {
    description: "wallet sem lançamentos continua na version 1",
    sql: `select w.id, w.version
            from wallets w
           where w.version <> 1
             and not exists (select 1 from wallet_ledger_entries l where l.wallet_id = w.id)`,
    format: (row) => `wallet ${row.id}: version ${row.version} sem nenhum lançamento no ledger`,
  },
  {
    description: "cada lançamento parte do saldo em que o anterior terminou",
    sql: `select wallet_id, wallet_version, balance_before::text as balance_before,
                 previous_after::text as previous_after
            from (
              select wallet_id, wallet_version, balance_before,
                     lag(balance_after) over (partition by wallet_id order by wallet_version) as previous_after
                from wallet_ledger_entries
            ) chain
           where (previous_after is not null and balance_before <> previous_after)
              or (wallet_version = 1 and balance_before <> 0)`,
    format: (row) =>
      `wallet ${row.wallet_id} v${row.wallet_version}: parte de ${row.balance_before}, esperado ${row.previous_after ?? "0.00"}`,
  },
  {
    description: "nenhuma transação não processada ou LOSS tem lançamento",
    sql: `select t.id, t.kind, t.status
            from wager_transactions t
            join wallet_ledger_entries l on l.transaction_id = t.id
           where t.status <> 'PROCESSED' or t.kind = 'LOSS'`,
    format: (row) => `transação ${row.id} (${row.kind}, ${row.status}) tem lançamento no ledger`,
  },
  {
    description: "todo lançamento tem um WalletBalanceChanged na outbox",
    sql: `select l.id, l.wallet_id, l.wallet_version
            from wallet_ledger_entries l
           where not exists (
             select 1 from outbox_messages o
              where o.event_type = 'WalletBalanceChanged'
                and o.aggregate_id = l.wallet_id
                and o.payload -> 'data' ->> 'transactionId' = l.transaction_id::text
                and (o.payload -> 'data' ->> 'walletVersion')::int = l.wallet_version
           )`,
    format: (row) =>
      `lançamento ${row.id} (wallet ${row.wallet_id} v${row.wallet_version}) sem WalletBalanceChanged na outbox`,
  },
];

export async function findInvariantViolations(client: Client): Promise<string[]> {
  const violations: string[] = [];

  for (const check of CHECKS) {
    const { rows } = await client.query(check.sql);

    for (const row of rows) {
      violations.push(`[${check.description}] ${check.format(row)}`);
    }
  }

  return violations;
}

export async function expectInvariants(client: Client): Promise<void> {
  expect(await findInvariantViolations(client)).toEqual([]);
}
