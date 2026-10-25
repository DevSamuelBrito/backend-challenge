import type { SQL } from "bun";
import type { LoadClient } from "./client";
import { delay, runClosedLoop } from "./engine";
import { toCents } from "./money";
import { type DrainResult, waitForOutboxDrain } from "./outbox";
import type { Execution } from "./scenarios";
import type { LoadSettings } from "./settings";
import { percentile } from "./stats";

const RECONCILIATION_CONCURRENCY = 8;
const POLL_INTERVAL_MS = 250;

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PendingStats {
  total: number;
  resolvedProcessed: number;
  resolutionP50Seconds: number;
  resolutionMaxSeconds: number;
}

export interface Verification {
  checks: Check[];
  drain: DrainResult;
  pending: PendingStats | null;
}

interface Dependencies {
  sql: SQL;
  client: LoadClient;
  settings: LoadSettings;
}

interface CountRow {
  n: number;
}

const check = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail });

async function waitForPendingResolved(sql: SQL, ids: readonly string[], timeoutSeconds: number) {
  const deadline = performance.now() + timeoutSeconds * 1000;

  while (true) {
    const rows = (await sql`
      select count(*)::int as n from wager_transactions
      where wallet_id in ${sql(ids)} and status in ('PENDING', 'PENDING_REFERENCE')
    `) as CountRow[];
    const remaining = rows[0]?.n ?? 0;

    if (remaining === 0 || performance.now() > deadline) {
      return remaining;
    }

    await delay(POLL_INTERVAL_MS);
  }
}

async function pendingStats(sql: SQL, pendingIds: readonly string[]): Promise<PendingStats | null> {
  if (pendingIds.length === 0) {
    return null;
  }

  const rows = (await sql`
    select status, extract(epoch from (processed_at - created_at))::float8 as seconds
    from wager_transactions where id in ${sql(pendingIds)}
  `) as { status: string; seconds: number | null }[];
  const resolved = rows.filter((row) => row.status === "PROCESSED" && row.seconds !== null);
  const seconds = resolved.map((row) => row.seconds as number);

  return {
    total: rows.length,
    resolvedProcessed: resolved.length,
    resolutionP50Seconds: percentile(seconds, 50),
    resolutionMaxSeconds: seconds.length === 0 ? Number.NaN : Math.max(...seconds),
  };
}

export async function verifyCorrectness(
  { sql, client, settings }: Dependencies,
  execution: Execution,
  loadEndedAt: number,
): Promise<Verification> {
  const ids = execution.wallets.map((wallet) => wallet.id);
  const checks: Check[] = [];

  const stillPending = await waitForPendingResolved(sql, ids, settings.pendingTimeoutSeconds);
  checks.push(
    check(
      "pendências resolvidas (nenhuma PENDING/PENDING_REFERENCE)",
      stillPending === 0,
      `${stillPending} ainda pendente(s)`,
    ),
  );

  const drain = await waitForOutboxDrain(sql, loadEndedAt, settings.drainTimeoutSeconds);
  checks.push(
    check(
      "outbox drenou (nenhum evento sem publicar)",
      drain.drained,
      drain.drained
        ? `drenou ${drain.seconds.toFixed(1)}s após o fim da carga`
        : `não drenou em ${settings.drainTimeoutSeconds}s`,
    ),
  );

  const [reconciliation, database] = await Promise.all([
    reconcileAll(client, ids),
    databaseChecks(sql, execution),
  ]);
  checks.push(...reconciliation, ...database);

  return { checks, drain, pending: await pendingStats(sql, execution.pendingIds) };
}

async function reconcileAll(client: LoadClient, ids: readonly string[]): Promise<Check[]> {
  const failures: string[] = [];

  await runClosedLoop(RECONCILIATION_CONCURRENCY, ids, async (id) => {
    const result = await client.reconcile(id);

    if (!result.consistent) {
      failures.push(`${id}: ${result.detail}`);
    }
  });

  return [
    check(
      "reconciliação (POST /wallets/:id/reconciliation) consistente em todas as wallets",
      failures.length === 0,
      failures.length === 0
        ? `${ids.length} wallet(s) consistentes`
        : failures.slice(0, 3).join("; "),
    ),
  ];
}

async function databaseChecks(sql: SQL, execution: Execution): Promise<Check[]> {
  const ids = execution.wallets.map((wallet) => wallet.id);
  const checks: Check[] = [];

  const balances = (await sql`
    select w.id::text as id, w.balance::text as balance,
           coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as ledger_net
    from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
    where w.id in ${sql(ids)}
    group by w.id, w.balance
  `) as { id: string; balance: string; ledger_net: string }[];
  const byId = new Map(balances.map((row) => [row.id, row]));

  const negative = balances.filter((row) => row.balance.startsWith("-"));
  checks.push(
    check(
      "nenhum saldo negativo",
      negative.length === 0,
      `${negative.length} wallet(s) negativa(s)`,
    ),
  );

  const wrongBalance = execution.wallets.filter((wallet) => {
    const row = byId.get(wallet.id);

    return !row || toCents(row.balance) !== wallet.expectedCents;
  });
  checks.push(
    check(
      "saldo final igual ao esperado calculado a priori",
      wrongBalance.length === 0,
      wrongBalance.length === 0
        ? `${ids.length} wallet(s) com o saldo esperado`
        : wrongBalance
            .slice(0, 3)
            .map(
              (wallet) =>
                `${wallet.id}: esperado ${wallet.expectedCents} centavos, banco ${byId.get(wallet.id)?.balance}`,
            )
            .join("; "),
    ),
  );

  const ledgerMismatch = balances.filter((row) => row.balance !== row.ledger_net);
  checks.push(
    check(
      "saldo da wallet igual à soma recalculada do ledger (SQL direto)",
      ledgerMismatch.length === 0,
      `${ledgerMismatch.length} divergência(s)`,
    ),
  );

  const rows = (await sql`
    select count(*)::int as total,
           count(*) filter (where status = 'PROCESSED')::int as processed,
           count(*) filter (where status = 'PROCESSED' and kind <> 'LOSS')::int as effects
    from wager_transactions where wallet_id in ${sql(ids)}
  `) as { total: number; processed: number; effects: number }[];
  const counts = rows[0] ?? { total: 0, processed: 0, effects: 0 };
  checks.push(
    check(
      "transações gravadas = esperado (nenhuma duplicada, nenhuma perdida)",
      counts.total === execution.transactionRows && counts.processed === execution.transactionRows,
      `esperado ${execution.transactionRows} PROCESSED, banco ${counts.processed} PROCESSED de ${counts.total}`,
    ),
  );

  const ledger =
    (await sql`select count(*)::int as n from wallet_ledger_entries where wallet_id in ${sql(ids)}`) as CountRow[];
  const ledgerCount = ledger[0]?.n ?? 0;
  checks.push(
    check(
      "cada efeito financeiro tem exatamente um lançamento no ledger",
      ledgerCount === execution.ledgerEntries && ledgerCount === counts.effects,
      `esperado ${execution.ledgerEntries}, ledger ${ledgerCount}, transações com efeito ${counts.effects}`,
    ),
  );

  const duplicates = (await sql`
    select
      (select count(*)::int from (
        select provider_id, external_transaction_id from wager_transactions
        where wallet_id in ${sql(ids)} group by 1, 2 having count(*) > 1) a) as by_external,
      (select count(*)::int from (
        select transaction_id from wallet_ledger_entries
        where wallet_id in ${sql(ids)} group by 1 having count(*) > 1) b) as by_ledger
  `) as { by_external: number; by_ledger: number }[];
  const duplicate = duplicates[0] ?? { by_external: -1, by_ledger: -1 };
  checks.push(
    check(
      "no máximo um efeito por transação externa",
      duplicate.by_external === 0 && duplicate.by_ledger === 0,
      `duplicadas por (provider, id externo): ${duplicate.by_external}; transações com 2+ lançamentos: ${duplicate.by_ledger}`,
    ),
  );

  const events = (await sql`
    select count(*)::int as n from outbox_messages
    where event_type = 'WalletBalanceChanged' and payload #>> '{data,walletId}' in ${sql(ids)}
  `) as CountRow[];
  checks.push(
    check(
      "um WalletBalanceChanged na outbox para cada lançamento do ledger",
      (events[0]?.n ?? -1) === ledgerCount,
      `eventos ${events[0]?.n}, lançamentos ${ledgerCount}`,
    ),
  );

  return checks;
}
