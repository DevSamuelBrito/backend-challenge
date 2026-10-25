import { describe, expect, test } from "bun:test";
import {
  currentContext,
  enrichContext,
  runWithContext,
} from "../../src/shared/application/request-context";

describe("contexto de requisição (AsyncLocalStorage)", () => {
  test("fora de um contexto está vazio e enrichContext não faz nada", () => {
    enrichContext({ walletId: "w" });

    expect(currentContext()).toEqual({});
  });

  test("o contexto atravessa await, timers e promessas aninhadas", async () => {
    await runWithContext({ correlationId: "c-1" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const nested = await Promise.resolve().then(() => currentContext().correlationId);

      expect(nested).toBe("c-1");
      expect(currentContext().correlationId).toBe("c-1");
    });
  });

  test("enrichContext acrescenta campos ao mesmo contexto e ignora undefined", async () => {
    await runWithContext({ correlationId: "c-1" }, async () => {
      enrichContext({ walletId: "w-1", providerId: undefined });
      await Promise.resolve();
      enrichContext({ transactionId: "t-1" });

      expect(currentContext()).toEqual({
        correlationId: "c-1",
        walletId: "w-1",
        transactionId: "t-1",
      });
    });
  });

  test("contextos concorrentes não se misturam", async () => {
    const seen = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        runWithContext({ correlationId: `c-${index}` }, async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
          enrichContext({ walletId: `w-${index}` });
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));

          return currentContext();
        }),
      ),
    );

    seen.forEach((context, index) => {
      expect(context).toEqual({ correlationId: `c-${index}`, walletId: `w-${index}` });
    });
  });

  test("um contexto interno não vaza para fora quando termina", () => {
    runWithContext({ correlationId: "externo" }, () => {
      runWithContext({ correlationId: "interno" }, () => {
        expect(currentContext().correlationId).toBe("interno");
      });

      expect(currentContext().correlationId).toBe("externo");
    });

    expect(currentContext()).toEqual({});
  });
});
