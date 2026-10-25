import { describe, expect, test } from "bun:test";
import type { AppRole } from "../../src/config/env";
import { PendingReferenceScheduler } from "../../src/modules/wagering/infrastructure/pending-reference.scheduler";
import { createGate, type Gate, waitUntil } from "../support/async";
import { ControlledClock } from "../support/doubles";

const INSTANT = new Date("2031-05-05T10:00:00.000Z");

function build(roles: AppRole[] = ["pending-worker"], tickIntervalMs = 2) {
  const calls: Date[] = [];
  let behaviour: (now: Date) => Promise<unknown> = async () => undefined;
  const worker = {
    tick: (now: Date) => {
      calls.push(now);
      return behaviour(now) as ReturnType<
        ConstructorParameters<typeof PendingReferenceScheduler>[0]["tick"]
      >;
    },
  };
  const scheduler = new PendingReferenceScheduler(worker, new ControlledClock(INSTANT), {
    roles,
    pendingReference: { tickIntervalMs },
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

function trackConcurrency() {
  const gates: Gate[] = [];
  const state = { running: 0, maxRunning: 0 };
  const tick = async () => {
    state.running += 1;
    state.maxRunning = Math.max(state.maxRunning, state.running);
    const gate = createGate();
    gates.push(gate);
    await gate.opened;
    state.running -= 1;
  };

  return { gates, state, tick };
}

describe("PendingReferenceScheduler", () => {
  test("não agenda nada sem o papel pending-worker", async () => {
    const { calls, scheduler } = build(["api", "consumer"]);

    scheduler.onModuleInit();
    await settle();
    await scheduler.stop();

    expect(calls).toHaveLength(0);
  });

  test("com o papel pending-worker, chama o tick repetidamente com a hora do Clock", async () => {
    const { calls, scheduler } = build();

    scheduler.onModuleInit();
    await waitUntil(() => calls.length >= 3, "3 ticks");
    await scheduler.stop();

    expect(calls.slice(0, 3)).toEqual([INSTANT, INSTANT, INSTANT]);
  });

  test("nunca sobrepõe ticks: enquanto um tick demora, nenhum outro começa", async () => {
    const { calls, scheduler, behave } = build();
    const tracked = trackConcurrency();
    behave(tracked.tick);

    scheduler.start();
    await waitUntil(() => calls.length === 1, "primeiro tick");
    await settle(60);

    expect(calls).toHaveLength(1);

    tracked.gates[0]?.open();
    await waitUntil(() => calls.length === 2, "segundo tick, só depois do primeiro terminar");
    tracked.gates[1]?.open();
    await scheduler.stop();

    expect(tracked.state.maxRunning).toBe(1);
  });

  test("stop espera o tick em andamento terminar e nenhum tick novo começa depois", async () => {
    const { calls, scheduler, behave } = build();
    const gate = createGate();
    behave(() => gate.opened);
    scheduler.start();
    await waitUntil(() => calls.length === 1, "tick em andamento");

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await settle(30);

    expect(stopped).toBe(false);

    gate.open();
    await stopping;
    const callsAtStop = calls.length;
    await settle(40);

    expect(stopped).toBe(true);
    expect(calls).toHaveLength(callsAtStop);
  });

  test("onModuleDestroy também espera o tick em andamento", async () => {
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

    expect(destroyed).toBe(true);
  });

  test("um tick que falha não derruba o agendador: o próximo tick acontece", async () => {
    const { calls, scheduler, behave } = build();
    let first = true;
    behave(async () => {
      if (first) {
        first = false;
        throw new Error("banco indisponível");
      }
    });

    scheduler.start();
    await waitUntil(() => calls.length >= 3, "ticks depois da falha");
    await scheduler.stop();

    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  test("start repetido não cria dois ciclos", async () => {
    const { calls, scheduler, behave } = build();
    const tracked = trackConcurrency();
    behave(tracked.tick);

    scheduler.start();
    scheduler.start();
    scheduler.start();
    await waitUntil(() => calls.length === 1, "tick");
    await settle(30);

    expect(tracked.state.maxRunning).toBe(1);
    tracked.gates[0]?.open();
    await scheduler.stop();
  });

  test("stop sem start é seguro, e o agendador pode ser iniciado de novo depois de parado", async () => {
    const { calls, scheduler } = build();

    await scheduler.stop();
    scheduler.start();
    await waitUntil(() => calls.length >= 1, "primeiro ciclo");
    await scheduler.stop();
    const afterFirst = calls.length;
    scheduler.start();
    await waitUntil(() => calls.length > afterFirst, "segundo ciclo");
    await scheduler.stop();
  });
});
