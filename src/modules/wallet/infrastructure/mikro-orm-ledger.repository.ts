import type { EntityManager } from "@mikro-orm/postgresql";
import { signedMoneyFromColumn } from "../../../shared/infrastructure/database/mapping";
import type {
  LedgerPageItem,
  LedgerRepository,
  LedgerSummary,
} from "../application/ledger.repository";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { ledgerEntryMapper } from "./ledger-entry.mapper";
import { LedgerEntrySchema } from "./ledger-entry.schema";

interface LedgerRow {
  seq: string;
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  wallet_version: number;
  created_at: string;
}

interface SummaryRow {
  calculated: string;
  entries: number;
}

const SELECT_PAGE = `
  select seq::text as seq, id, wallet_id, transaction_id, direction,
         amount::text as amount, currency,
         balance_before::text as balance_before, balance_after::text as balance_after,
         wallet_version,
         to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
    from wallet_ledger_entries
   where wallet_id = ? and seq > ?::bigint
   order by wallet_ledger_entries.seq
   limit ?
`;

const SUMMARIZE = `
  select coalesce(
           sum(case direction when 'CREDIT' then amount else -amount end), 0
         )::numeric(20,2)::text as calculated,
         count(*)::int as entries
    from wallet_ledger_entries
   where wallet_id = ?
`;

const BEFORE_FIRST_SEQ = "0";

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerEntryMapper.toRecord(entry));
  }

  async findPage(
    walletId: string,
    afterSeq: string | undefined,
    limit: number,
  ): Promise<LedgerPageItem[]> {
    const rows = await this.em.execute<LedgerRow[]>(SELECT_PAGE, [
      walletId,
      afterSeq ?? BEFORE_FIRST_SEQ,
      limit,
    ]);

    return rows.map((row) => ({
      seq: row.seq,
      entry: ledgerEntryMapper.toDomain({
        id: row.id,
        walletId: row.wallet_id,
        transactionId: row.transaction_id,
        direction: row.direction,
        amount: row.amount,
        currency: row.currency,
        balanceBefore: row.balance_before,
        balanceAfter: row.balance_after,
        walletVersion: row.wallet_version,
        createdAt: new Date(row.created_at),
      }),
    }));
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<SummaryRow[]>(SUMMARIZE, [walletId]);

    if (!row) {
      throw new Error(`Soma do ledger da wallet ${walletId} não devolveu linha`);
    }

    return {
      calculatedBalance: signedMoneyFromColumn(row.calculated, currency),
      entries: row.entries,
    };
  }
}
