import { Migration } from "@mikro-orm/migrations";

export class Migration20261025120000_add_ledger_wallet_seq_index extends Migration {
  override name = "Migration20261025120000_add_ledger_wallet_seq_index";

  override up(): void | Promise<void> {
    this.addSql(
      "create index wallet_ledger_entries_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq)",
    );
  }

  override down(): void | Promise<void> {
    this.addSql("drop index wallet_ledger_entries_wallet_seq_idx");
  }
}
