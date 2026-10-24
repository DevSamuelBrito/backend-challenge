import { MikroORM } from "@mikro-orm/core";
import { Inject, Injectable } from "@nestjs/common";
import type { HealthIndicator } from "./health-indicator";
import { withTimeout } from "./with-timeout";

const TIMEOUT_MS = 2000;

@Injectable()
export class PostgresIndicator implements HealthIndicator {
  readonly name = "postgres";

  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async check(): Promise<void> {
    await withTimeout(this.orm.em.getConnection().execute("select 1"), TIMEOUT_MS, this.name);
  }
}
