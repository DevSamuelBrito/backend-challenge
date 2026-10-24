import { Migration } from "@mikro-orm/migrations";

export class Migration20261024141718_spike_compat extends Migration {
  override name = "Migration20261024141718_spike_compat";

  override up(): void | Promise<void> {
    this.addSql("create table spike_migration_check (id int primary key);");
  }

  override down(): void | Promise<void> {
    this.addSql("drop table spike_migration_check;");
  }
}
