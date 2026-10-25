import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { EVENT_PUBLISHER } from "../../src/modules/messaging/application/event-publisher.port";
import type { OutboxTickReport } from "../../src/modules/messaging/application/outbox-publisher";
import { CLOCK } from "../../src/shared/application/clock.port";
import { FAULT_INJECTOR } from "../../src/shared/application/fault-injector.port";
import { createGate } from "./async";
import { ControlledClock } from "./doubles";
import { expectInvariants } from "./invariants";
import {
  AT,
  type CountingPublisher,
  countingPublisher,
  createEventsQueue,
  type EventsQueue,
  outboxPublisherOf,
  ScriptedFaultInjector,
} from "./outbox";
import { startWalletApi, type WalletApi, type WalletApiOptions } from "./wallet-api";

export interface Hold {
  reached: Promise<void>;
  release(decision: "commit" | "rollback"): void;
}

export function useOutbox(
  env: Record<string, string> = {},
  options: Omit<WalletApiOptions, "env" | "providers" | "wrapUnitOfWork"> = {},
) {
  let api: WalletApi;
  let queue: EventsQueue;
  let publisher: CountingPublisher;
  const faults = new ScriptedFaultInjector();
  const clock = new ControlledClock(AT);
  let armed: { reached: () => void; decision: Promise<"commit" | "rollback"> } | undefined;

  beforeAll(async () => {
    queue = await createEventsQueue();
    publisher = countingPublisher(queue.name);
    api = await startWalletApi({
      ...options,
      env: { SQS_EVENTS_QUEUE: queue.name, ...env },
      providers: [
        { token: CLOCK, value: clock },
        { token: EVENT_PUBLISHER, value: publisher },
        { token: FAULT_INJECTOR, value: faults },
      ],
      wrapUnitOfWork: (real) => ({
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
    });
  });

  afterAll(async () => {
    await api.close();
    await queue.close();
  });

  beforeEach(async () => {
    await api.db.client.query(
      "update outbox_messages set published_at = now() where published_at is null",
    );
    await queue.purge();
    publisher.reset();
    publisher.gate = undefined;
    faults.disarm();
    faults.reached.length = 0;
    clock.set(AT);
  });

  afterEach(async () => {
    await expectInvariants(api.db.client);
  });

  return {
    clock,
    faults,
    get api() {
      return api;
    },
    get client() {
      return api.db.client;
    },
    get queue() {
      return queue;
    },
    get publisher() {
      return publisher;
    },
    tick(now: Date = clock.now()): Promise<OutboxTickReport> {
      return outboxPublisherOf(api).tick(now);
    },
    holdNextTransaction(): Hold {
      const reachedGate = createGate();
      let decide: (decision: "commit" | "rollback") => void = () => undefined;
      const decision = new Promise<"commit" | "rollback">((resolve) => {
        decide = resolve;
      });
      armed = { reached: () => reachedGate.open(), decision };

      return { reached: reachedGate.opened, release: (value) => decide(value) };
    },
  };
}
