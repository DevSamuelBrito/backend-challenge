import { MikroORM } from "@mikro-orm/core";
import type { MikroORM as PostgreSqlMikroORM } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env";
import { UNIT_OF_WORK } from "../../application/unit-of-work.port";
import { createRepositories } from "./create-repositories";
import { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work";

@Module({
  providers: [
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM, APP_CONFIG],
      useFactory: (orm: PostgreSqlMikroORM, config: AppConfig) =>
        new MikroOrmUnitOfWork(orm, createRepositories, {
          lockTimeoutMs: config.databaseLockTimeoutMs,
        }),
    },
  ],
  exports: [UNIT_OF_WORK],
})
export class PersistenceModule {}
