import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}
