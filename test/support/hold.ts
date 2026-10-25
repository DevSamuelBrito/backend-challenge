import type { UnitOfWork } from "../../src/shared/application/unit-of-work.port";
import { createGate } from "./async";

export interface Hold {
  reached: Promise<void>;
  release(decision?: "commit" | "rollback"): void;
}

export function holdingUnitOfWork() {
  let armed: { reached: () => void; decision: Promise<"commit" | "rollback"> } | undefined;

  return {
    wrap: (real: UnitOfWork): UnitOfWork => ({
      run: (work) => {
        const hold = armed;
        armed = undefined;

        if (!hold) {
          return real.run(work);
        }

        return real.run(async (repositories) => {
          const result = await work(repositories);
          hold.reached();

          if ((await hold.decision) === "rollback") {
            throw new Error("rollback forçado pelo teste");
          }

          return result;
        });
      },
    }),

    holdNext(): Hold {
      const reachedGate = createGate();
      let decide: (decision: "commit" | "rollback") => void = () => undefined;
      const decision = new Promise<"commit" | "rollback">((resolve) => {
        decide = resolve;
      });
      armed = { reached: () => reachedGate.open(), decision };

      return { reached: reachedGate.opened, release: (value = "commit") => decide(value) };
    },
  };
}
