import { MikroORM } from "@mikro-orm/core";
import type { MikroORM as PostgreSqlMikroORM } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env";
import { METRICS, type Metrics } from "../../application/metrics.port";
import { UNIT_OF_WORK } from "../../application/unit-of-work.port";
import { createRepositories } from "./create-repositories";
import { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work";

@Module({
  providers: [
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM, APP_CONFIG, { token: METRICS, optional: true }],
      useFactory: (orm: PostgreSqlMikroORM, config: AppConfig, metrics: Metrics | undefined) =>
        new MikroOrmUnitOfWork(orm, createRepositories, {
          lockTimeoutMs: config.databaseLockTimeoutMs,
          onLockTimeout: () => metrics?.lockTimeout(),
        }),
    },
  ],
  exports: [UNIT_OF_WORK],
})
export class PersistenceModule {}
