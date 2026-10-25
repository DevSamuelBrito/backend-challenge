import type { EntityManager } from "@mikro-orm/postgresql";
import { LockTimeoutError } from "../../application/persistence-errors";
import type { Repositories, UnitOfWork } from "../../application/unit-of-work.port";

const LOCK_NOT_AVAILABLE = "55P03";

export type RepositoryFactory = (em: EntityManager) => Repositories;

export interface UnitOfWorkOptions {
  lockTimeoutMs: number;
  onLockTimeout?: () => void;
}

function isLockTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === LOCK_NOT_AVAILABLE
  );
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: { em: EntityManager },
    private readonly createRepositories: RepositoryFactory,
    private readonly options: UnitOfWorkOptions,
  ) {
    if (!Number.isInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0) {
      throw new Error(`lockTimeoutMs inválido: ${options.lockTimeoutMs}`);
    }
  }

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork();

    try {
      return await em.transactional(async (transactionEm) => {
        await transactionEm.execute(`set local lock_timeout = ${this.options.lockTimeoutMs}`);

        return work(this.createRepositories(transactionEm));
      });
    } catch (error) {
      if (isLockTimeout(error)) {
        this.options.onLockTimeout?.();
        throw new LockTimeoutError(this.options.lockTimeoutMs, { cause: error });
      }

      throw error;
    }
  }
}
