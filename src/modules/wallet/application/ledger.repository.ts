import type { Money } from "../../../shared/domain/money";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface LedgerPageItem {
  seq: string;
  entry: WalletLedgerEntry;
}

export interface LedgerSummary {
  calculatedBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findPage(
    walletId: string,
    afterSeq: string | undefined,
    limit: number,
  ): Promise<LedgerPageItem[]>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}
