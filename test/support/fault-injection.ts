import type { Repositories, UnitOfWork } from "../../src/shared/application/unit-of-work.port";

export interface FaultPlan {
  failAt?: string;
}

export const INJECTED_FAILURE = "falha injetada";

function guarded<T extends object>(
  name: string,
  target: T,
  plan: FaultPlan,
  calls: Record<string, number>,
): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);

      if (typeof value !== "function") {
        return value;
      }

      return async (...args: unknown[]) => {
        const key = `${name}.${String(property)}`;
        calls[key] = (calls[key] ?? 0) + 1;

        const result = await value.apply(object, args);
        const point = `${key}:${calls[key]}`;

        if (plan.failAt === point) {
          plan.failAt = undefined;
          throw new Error(`${INJECTED_FAILURE} depois de ${point}`);
        }

        return result;
      };
    },
  });
}

export function faultyUnitOfWork(real: UnitOfWork, plan: FaultPlan): UnitOfWork {
  return {
    run: (work) =>
      real.run((repositories) => {
        const calls: Record<string, number> = {};
        const wrapped: Repositories = {
          wallets: guarded("wallets", repositories.wallets, plan, calls),
          transactions: guarded("transactions", repositories.transactions, plan, calls),
          ledger: guarded("ledger", repositories.ledger, plan, calls),
          inbox: guarded("inbox", repositories.inbox, plan, calls),
          outbox: guarded("outbox", repositories.outbox, plan, calls),
        };

        return work(wrapped);
      }),
  };
}
