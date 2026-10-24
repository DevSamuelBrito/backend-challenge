import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Inject, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConfigModule } from "../../src/config/config.module";
import { LockTimeoutError } from "../../src/shared/application/persistence-errors";
import { UNIT_OF_WORK, type UnitOfWork } from "../../src/shared/application/unit-of-work.port";
import { DatabaseModule } from "../../src/shared/infrastructure/database/database.module";
import { PersistenceModule } from "../../src/shared/infrastructure/database/persistence.module";
import { type RunningApp, startApp } from "../support/app";
import { createGate } from "../support/async";
import { createMigratedDatabase, type TestDatabase } from "../support/database";
import { aNewWallet } from "../support/persistence-builders";
import { testConfig } from "../support/test-config";

const LOCK_TIMEOUT_MS = 300;

describe("PersistenceModule dentro do AppModule", () => {
  let db: TestDatabase;
  let running: RunningApp;
  let uow: UnitOfWork;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    running = await startApp(
      testConfig({ DATABASE_URL: db.url, DB_LOCK_TIMEOUT_MS: String(LOCK_TIMEOUT_MS) }),
    );
    uow = running.app.get<UnitOfWork>(UNIT_OF_WORK);
  });

  afterAll(async () => {
    await running.app.close();
    await db.close();
  });

  test("a porta UnitOfWork resolve para uma instância única, exportada pelo módulo", () => {
    expect(uow).toBeDefined();
    expect(running.app.get(UNIT_OF_WORK)).toBe(uow);
  });

  test("outro módulo que importa o PersistenceModule consegue injetar a porta UnitOfWork", async () => {
    @Injectable()
    class FeatureService {
      constructor(@Inject(UNIT_OF_WORK) readonly unitOfWork: UnitOfWork) {}
    }

    @Module({ imports: [PersistenceModule], providers: [FeatureService] })
    class FeatureModule {}

    @Module({
      imports: [
        ConfigModule.forRoot(testConfig({ DATABASE_URL: db.url })),
        DatabaseModule,
        FeatureModule,
      ],
    })
    class RootModule {}

    const context = await NestFactory.createApplicationContext(RootModule, {
      logger: false,
      abortOnError: false,
    });

    try {
      const service = context.get(FeatureService);
      const wallet = aNewWallet();

      await service.unitOfWork.run(({ wallets }) => wallets.add(wallet));

      expect(await service.unitOfWork.run(({ wallets }) => wallets.findById(wallet.id))).toEqual(
        wallet,
      );
    } finally {
      await context.close();
    }
  });

  test("grava e lê uma wallet pelo UnitOfWork do container", async () => {
    const wallet = aNewWallet();

    await uow.run(({ wallets }) => wallets.add(wallet));

    expect(await uow.run(({ wallets }) => wallets.findById(wallet.id))).toEqual(wallet);
  });

  test("o lock_timeout da configuração (DB_LOCK_TIMEOUT_MS) chega ao UnitOfWork do container", async () => {
    const wallet = aNewWallet();
    await uow.run(({ wallets }) => wallets.add(wallet));

    const holderHasLock = createGate();
    const releaseHolder = createGate();
    const holder = uow.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(wallet.id);
      holderHasLock.open();
      await releaseHolder.opened;
    });

    await holderHasLock.opened;
    const failure = await uow
      .run(({ wallets }) => wallets.findByIdForUpdate(wallet.id))
      .catch((error: unknown) => error);

    releaseHolder.open();
    await holder;

    expect(failure).toBeInstanceOf(LockTimeoutError);
    expect((failure as LockTimeoutError).message).toContain(`${LOCK_TIMEOUT_MS}ms`);
  });
});
