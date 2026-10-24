import "reflect-metadata";
import { MikroORM } from "@mikro-orm/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";
import { APP_CONFIG } from "../../src/config/config.module";
import type { AppConfig } from "../../src/config/env";
import { UNIT_OF_WORK, type UnitOfWork } from "../../src/shared/application/unit-of-work.port";
import { createRepositories } from "../../src/shared/infrastructure/database/create-repositories";
import { MikroOrmUnitOfWork } from "../../src/shared/infrastructure/database/mikro-orm-unit-of-work";
import { createMigratedDatabase, type TestDatabase } from "./database";
import { createHttpClient, type HttpClient } from "./http";
import { testConfig } from "./test-config";

export interface ProviderOverride {
  token: unknown;
  value: unknown;
}

export interface WalletApiOptions {
  providers?: readonly ProviderOverride[];
  wrapUnitOfWork?: (real: UnitOfWork) => UnitOfWork;
}

export interface WalletApi {
  db: TestDatabase;
  app: INestApplication;
  url: string;
  http: HttpClient;
  close(): Promise<void>;
}

export async function startWalletApi(options: WalletApiOptions = {}): Promise<WalletApi> {
  const db = await createMigratedDatabase();
  const config = testConfig({ DATABASE_URL: db.url });

  let builder = Test.createTestingModule({ imports: [AppModule.register(config)] });

  for (const { token, value } of options.providers ?? []) {
    builder = builder.overrideProvider(token as string).useValue(value);
  }

  const { wrapUnitOfWork } = options;

  if (wrapUnitOfWork) {
    builder = builder.overrideProvider(UNIT_OF_WORK).useFactory({
      inject: [MikroORM, APP_CONFIG],
      factory: (orm: ConstructorParameters<typeof MikroOrmUnitOfWork>[0], appConfig: AppConfig) =>
        wrapUnitOfWork(
          new MikroOrmUnitOfWork(orm, createRepositories, {
            lockTimeoutMs: appConfig.databaseLockTimeoutMs,
          }),
        ),
    });
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: ["error"] });
  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();

  return {
    db,
    app,
    url,
    http: createHttpClient(url),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
