import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { EVENT_PUBLISHER } from "../../src/modules/messaging/application/event-publisher.port";
import { CLOCK } from "../../src/shared/application/clock.port";
import { createGate } from "../support/async";
import { ControlledClock } from "../support/doubles";
import type { HttpClient } from "../support/http";
import { expectInvariants } from "../support/invariants";
import {
  AT,
  type CountingPublisher,
  countingPublisher,
  createEventsQueue,
  type EventsQueue,
  outboxPublisherOf,
  pendingCount,
  seedOutbox,
} from "../support/outbox";
import { keyFor, openWallet, submit, wagerPayload } from "../support/wagering-api";
import {
  type AppInstance,
  type Cluster,
  startCluster,
  startInstance,
  startWalletApi,
  type WalletApi,
} from "../support/wallet-api";

const INSTANCES = 3;
const money = (amount: string) => ({ amount, currency: "BRL" });

describe(`${INSTANCES} publishers da outbox executando tick em paralelo`, () => {
  let cluster: Cluster;
  let queue: EventsQueue;
  let publisher: CountingPublisher;

  beforeAll(async () => {
    queue = await createEventsQueue();
    publisher = countingPublisher(queue.name);
    cluster = await startCluster(INSTANCES, {
      env: { APP_ROLES: "api", SQS_EVENTS_QUEUE: queue.name },
      providers: [
        { token: CLOCK, value: new ControlledClock(AT) },
        { token: EVENT_PUBLISHER, value: publisher },
      ],
    });
  });

  afterAll(async () => {
    await cluster.close();
    await queue.close();
  });

  afterEach(async () => {
    await expectInvariants(cluster.db.client);
    await cluster.db.client.query(
      "update outbox_messages set published_at = now() where published_at is null",
    );
    await queue.purge();
    publisher.reset();
  });

  const client = () => cluster.db.client;

  async function drainAll(now: Date): Promise<void> {
    await Promise.all(
      cluster.instances.map(async (instance: AppInstance) => {
        for (
          let iteration = 0;
          iteration < 200 && (await pendingCount(client())) > 0;
          iteration++
        ) {
          await outboxPublisherOf(instance).tick(now);
        }
      }),
    );
  }

  test("5 rodadas de 300 mensagens: todas publicadas, cada uma enviada EXATAMENTE uma vez, nenhuma perdida, nenhum deadlock", async () => {
    for (let round = 0; round < 5; round++) {
      const ids = await seedOutbox(
        client(),
        Array.from({ length: 300 }, (_, index) => ({ walletId: `grupo-${index % 20}` })),
      );

      await drainAll(AT);

      expect(await pendingCount(client())).toBe(0);
      expect(publisher.sent).toHaveLength(300);
      expect(new Set(publisher.sent)).toEqual(new Set(ids));
      for (const id of ids) {
        expect(publisher.sendsOf(id)).toBe(1);
      }

      const received = await queue.drain(300, 30_000);
      expect(received).toHaveLength(300);
      expect(new Set(received.map((event) => event.body.eventId))).toEqual(new Set(ids));

      await client().query("update outbox_messages set published_at = now() where true");
      publisher.reset();
    }
  }, 120_000);

  test("os 3 ticks no MESMO instante, sobre as mesmas pendências: os lotes são disjuntos (ninguém repete)", async () => {
    const ids = await seedOutbox(
      client(),
      Array.from({ length: 30 }, (_, index) => ({ walletId: `grupo-${index % 3}` })),
    );

    const reports = await Promise.all(
      cluster.instances.map((instance) => outboxPublisherOf(instance).tick(AT)),
    );

    expect(reports.reduce((total, report) => total + report.claimed, 0)).toBe(30);
    expect(reports.reduce((total, report) => total + report.published, 0)).toBe(30);
    expect(publisher.sent).toHaveLength(30);
    expect(new Set(publisher.sent)).toEqual(new Set(ids));
    expect(await pendingCount(client())).toBe(0);
  });

  test("negócio acontecendo ao mesmo tempo que os publishers: no fim, todo evento commitado foi publicado uma única vez", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        openWallet(cluster.http[index % INSTANCES] as HttpClient, "100.00"),
      ),
    );
    let producing = true;

    const publishers = Promise.all(
      cluster.instances.map(async (instance) => {
        while (producing) {
          await outboxPublisherOf(instance).tick(AT);
        }
      }),
    );

    await Promise.all(
      wallets.flatMap((wallet, index) =>
        Array.from({ length: 3 }, async () => {
          const payload = wagerPayload(wallet, { kind: "BET", money: money("1.00") });
          const response = await submit(
            cluster.http[index % INSTANCES] as HttpClient,
            payload,
            keyFor(payload),
          );
          expect(response.status).toBe(200);
        }),
      ),
    );
    producing = false;
    await publishers;
    await drainAll(AT);

    const { rows } = await client().query(
      "select id from outbox_messages where payload -> 'data' ->> 'walletId' = any($1)",
      [wallets.map((wallet) => wallet.id)],
    );
    expect(rows).toHaveLength(12 * 2 + 12 * 3 * 2);
    expect(await pendingCount(client())).toBe(0);
    for (const row of rows) {
      expect(publisher.sendsOf(row.id as string)).toBe(1);
    }
    const received = await queue.drain(rows.length, 30_000);
    expect(received).toHaveLength(rows.length);
    expect(publisher.sent).toHaveLength(rows.length);
  }, 60_000);
});

describe("SKIP LOCKED: um publisher lento não bloqueia os outros", () => {
  let first: WalletApi;
  let second: AppInstance;
  let queue: EventsQueue;
  let slowPublisher: CountingPublisher;
  let fastPublisher: CountingPublisher;

  beforeAll(async () => {
    queue = await createEventsQueue();
    slowPublisher = countingPublisher(queue.name);
    fastPublisher = countingPublisher(queue.name);
    first = await startWalletApi({
      env: { APP_ROLES: "api", SQS_EVENTS_QUEUE: queue.name },
      providers: [
        { token: CLOCK, value: new ControlledClock(AT) },
        { token: EVENT_PUBLISHER, value: slowPublisher },
      ],
    });
    second = await startInstance(first.db, {
      env: { APP_ROLES: "api", SQS_EVENTS_QUEUE: queue.name },
      providers: [
        { token: CLOCK, value: new ControlledClock(AT) },
        { token: EVENT_PUBLISHER, value: fastPublisher },
      ],
    });
  });

  afterAll(async () => {
    await second.close();
    await first.close();
    await queue.close();
  });

  test("enquanto o publisher A segura o lote 1 (locks abertos), o publisher B pega o lote 2 sem esperar", async () => {
    const ids = await seedOutbox(
      first.db.client,
      Array.from({ length: 20 }, () => ({})),
    );
    const gate = createGate();
    slowPublisher.gate = gate.opened;

    const slow = outboxPublisherOf(first).tick(AT);
    while (slowPublisher.sent.length < 10) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const other = await Promise.race([
      outboxPublisherOf(second).tick(AT),
      new Promise<"travou">((resolve) => setTimeout(() => resolve("travou"), 4000)),
    ]);

    expect(other).toEqual({ claimed: 10, published: 10, failed: 0 });
    expect(fastPublisher.sent).toHaveLength(10);
    expect(fastPublisher.sent.filter((id) => slowPublisher.sent.includes(id))).toEqual([]);

    gate.open();
    expect(await slow).toEqual({ claimed: 10, published: 10, failed: 0 });
    expect(await pendingCount(first.db.client)).toBe(0);
    expect(new Set([...slowPublisher.sent, ...fastPublisher.sent])).toEqual(new Set(ids));
    expect(slowPublisher.sent.length + fastPublisher.sent.length).toBe(20);
  });
});
