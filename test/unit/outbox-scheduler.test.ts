import { describe, expect, test } from "bun:test";
import type { AppRole } from "../../src/config/env";
import { OutboxScheduler } from "../../src/modules/messaging/infrastructure/outbox.scheduler";
import { createGate, type Gate, waitUntil } from "../support/async";
import { ControlledClock } from "../support/doubles";

const INSTANT = new Date("2031-05-05T10:00:00.000Z");

function build(roles: AppRole[] = ["outbox"], tickIntervalMs = 2) {
  const calls: Date[] = [];
  let behaviour: (now: Date) => Promise<unknown> = async () => undefined;
  const publisher = {
    tick: (now: Date) => {
      calls.push(now);
      return behaviour(now) as ReturnType<ConstructorParameters<typeof OutboxScheduler>[0]["tick"]>;
    },
  };
  const scheduler = new OutboxScheduler(publisher, new ControlledClock(INSTANT), {
    roles,
    outbox: { tickIntervalMs },
  });

  return {
    calls,
    scheduler,
    behave: (next: (now: Date) => Promise<unknown>) => {
      behaviour = next;
    },
  };
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe("OutboxScheduler", () => {
  test("não agenda nada sem o papel outbox (pending-worker sozinho não basta)", async () => {
    const { calls, scheduler } = build(["api", "pending-worker"]);

    scheduler.onModuleInit();
    await settle();
    await scheduler.stop();

    expect(calls).toHaveLength(0);
  });

  test("com o papel outbox, chama o tick repetidamente com a hora do Clock", async () => {
    const { calls, scheduler } = build();

    scheduler.onModuleInit();
    await waitUntil(() => calls.length >= 3, "3 ticks");
    await scheduler.stop();

    expect(calls.slice(0, 3)).toEqual([INSTANT, INSTANT, INSTANT]);
  });

  test("nunca sobrepõe ticks: enquanto um tick demora, nenhum outro começa", async () => {
    const { calls, scheduler, behave } = build();
    const gates: Gate[] = [];
    let running = 0;
    let maxRunning = 0;
    behave(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      const gate = createGate();
      gates.push(gate);
      await gate.opened;
      running -= 1;
    });

    scheduler.start();
    await waitUntil(() => calls.length === 1, "primeiro tick");
    await settle(60);

    expect(calls).toHaveLength(1);

    gates[0]?.open();
    await waitUntil(() => calls.length === 2, "segundo tick");
    gates[1]?.open();
    await scheduler.stop();

    expect(maxRunning).toBe(1);
  });

  test("stop e onModuleDestroy esperam o tick em andamento e nenhum tick novo começa depois", async () => {
    const { calls, scheduler, behave } = build();
    const gate = createGate();
    behave(() => gate.opened);
    scheduler.onModuleInit();
    await waitUntil(() => calls.length === 1, "tick em andamento");

    let destroyed = false;
    const destroying = scheduler.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await settle(30);
    expect(destroyed).toBe(false);

    gate.open();
    await destroying;
    const callsAtStop = calls.length;
    await settle(40);

    expect(destroyed).toBe(true);
    expect(calls).toHaveLength(callsAtStop);
  });

  test("um tick que falha não derruba o agendador", async () => {
    const { calls, scheduler, behave } = build();
    let first = true;
    behave(async () => {
      if (first) {
        first = false;
        throw new Error("SQS indisponível");
      }
    });

    scheduler.start();
    await waitUntil(() => calls.length >= 3, "ticks depois da falha");
    await scheduler.stop();

    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});
