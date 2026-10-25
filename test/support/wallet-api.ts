import "reflect-metadata";
import { MikroORM } from "@mikro-orm/core";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module";
import { APP_CONFIG } from "../../src/config/config.module";
import type { AppConfig } from "../../src/config/env";
import { METRICS, type Metrics } from "../../src/shared/application/metrics.port";
import { UNIT_OF_WORK, type UnitOfWork } from "../../src/shared/application/unit-of-work.port";
import { createRepositories } from "../../src/shared/infrastructure/database/create-repositories";
import { MikroOrmUnitOfWork } from "../../src/shared/infrastructure/database/mikro-orm-unit-of-work";
import { PinoLoggerService } from "../../src/shared/infrastructure/observability/pino-logger";
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
  lockTimeoutMs?: number;
  env?: Record<string, string>;
  useAppLogger?: boolean;
}

export interface AppInstance {
  app: INestApplication;
  url: string;
  http: HttpClient;
  close(): Promise<void>;
}

export interface WalletApi extends AppInstance {
  db: TestDatabase;
}

export interface Cluster {
  db: TestDatabase;
  instances: AppInstance[];
  http: HttpClient[];
  close(): Promise<void>;
}

export async function startInstance(
  db: TestDatabase,
  options: WalletApiOptions = {},
): Promise<AppInstance> {
  const config = testConfig({
    DATABASE_URL: db.url,
    ...(options.lockTimeoutMs && { DB_LOCK_TIMEOUT_MS: String(options.lockTimeoutMs) }),
    ...options.env,
  });

  let builder = Test.createTestingModule({ imports: [AppModule.register(config)] });

  for (const { token, value } of options.providers ?? []) {
    builder = builder.overrideProvider(token as string).useValue(value);
  }

  const { wrapUnitOfWork } = options;

  if (wrapUnitOfWork) {
    builder = builder.overrideProvider(UNIT_OF_WORK).useFactory({
      inject: [MikroORM, APP_CONFIG, METRICS],
      factory: (
        orm: ConstructorParameters<typeof MikroOrmUnitOfWork>[0],
        appConfig: AppConfig,
        metrics: Metrics,
      ) =>
        wrapUnitOfWork(
          new MikroOrmUnitOfWork(orm, createRepositories, {
            lockTimeoutMs: appConfig.databaseLockTimeoutMs,
            onLockTimeout: () => metrics.lockTimeout(),
          }),
        ),
    });
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: ["error"] });

  if (options.useAppLogger) {
    app.useLogger(app.get(PinoLoggerService));
  }

  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();

  return { app, url, http: createHttpClient(url), close: () => app.close() };
}

export async function startWalletApi(options: WalletApiOptions = {}): Promise<WalletApi> {
  const db = await createMigratedDatabase();
  const instance = await startInstance(db, options);

  return {
    ...instance,
    db,
    close: async () => {
      await instance.close();
      await db.close();
    },
  };
}

export async function startCluster(
  instanceCount: number,
  options: WalletApiOptions = {},
): Promise<Cluster> {
  const db = await createMigratedDatabase();
  const instances = await Promise.all(
    Array.from({ length: instanceCount }, () => startInstance(db, options)),
  );

  return {
    db,
    instances,
    http: instances.map((instance) => instance.http),
    close: async () => {
      await Promise.all(instances.map((instance) => instance.close()));
      await db.close();
    },
  };
}
