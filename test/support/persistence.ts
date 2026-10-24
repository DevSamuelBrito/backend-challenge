import { MikroORM } from "@mikro-orm/postgresql";
import { createRepositories } from "../../src/shared/infrastructure/database/create-repositories";
import { MikroOrmUnitOfWork } from "../../src/shared/infrastructure/database/mikro-orm-unit-of-work";
import { buildOrmOptions } from "../../src/shared/infrastructure/database/orm-options";
import { createMigratedDatabase, type TestDatabase } from "./database";

export interface PersistenceHarness {
  db: TestDatabase;
  orm: MikroORM;
  uow: MikroOrmUnitOfWork;
  unitOfWork(lockTimeoutMs: number): MikroOrmUnitOfWork;
  close(): Promise<void>;
}

export async function startPersistence(lockTimeoutMs = 5000): Promise<PersistenceHarness> {
  const db = await createMigratedDatabase();
  const orm = await MikroORM.init(buildOrmOptions(db.url));

  const unitOfWork = (timeoutMs: number) =>
    new MikroOrmUnitOfWork(orm, createRepositories, { lockTimeoutMs: timeoutMs });

  return {
    db,
    orm,
    uow: unitOfWork(lockTimeoutMs),
    unitOfWork,
    close: async () => {
      await orm.close();
      await db.close();
    },
  };
}
