import { afterEach, describe, expect, test } from "bun:test";
import { EVENT_PUBLISHER } from "../../src/modules/messaging/application/event-publisher.port";
import { createGate, waitUntil } from "../support/async";
import { expectInvariants } from "../support/invariants";
import {
  countingPublisher,
  createEventsQueue,
  type EventsQueue,
  outboxRows,
  pendingCount,
} from "../support/outbox";
import { keyFor, openWallet, submit, wagerPayload } from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

describe("agendador do publisher da outbox dentro da aplicação Nest", () => {
  let api: WalletApi | undefined;
  let queue: EventsQueue | undefined;

  afterEach(async () => {
    if (api) {
      await expectInvariants(api.db.client);
      await api.close().catch(() => undefined);
      api = undefined;
    }
    await queue?.close();
    queue = undefined;
  });

  test("com o papel outbox, a aplicação publica sozinha os eventos de uma BET", async () => {
    queue = await createEventsQueue();
    api = await startWalletApi({
      env: { APP_ROLES: "api,outbox", OUTBOX_INTERVAL_MS: "50", SQS_EVENTS_QUEUE: queue.name },
    });
    const wallet = await openWallet(api.http, "100.00");
    const payload = wagerPayload(wallet, {
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    });
    expect((await submit(api.http, payload, keyFor(payload))).status).toBe(200);
    const client = api.db.client;

    await waitUntil(
      async () => (await pendingCount(client)) === 0,
      "a outbox ser publicada",
      15_000,
    );

    const received = await queue.drain(4);
    expect(received).toHaveLength(4);
    expect(new Set(received.map((event) => event.groupId))).toEqual(new Set([wallet.id]));
    const rows = await outboxRows(client);
    expect(rows.every((row) => row.published_at !== null && row.attempts === 0)).toBe(true);
  });

  test("sem o papel outbox, nada é publicado sozinho", async () => {
    queue = await createEventsQueue();
    const publisher = countingPublisher(queue.name);
    api = await startWalletApi({
      env: { APP_ROLES: "api", OUTBOX_INTERVAL_MS: "20", SQS_EVENTS_QUEUE: queue.name },
      providers: [{ token: EVENT_PUBLISHER, value: publisher }],
    });
    await openWallet(api.http, "100.00");

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(publisher.sent).toHaveLength(0);
    expect(await pendingCount(api.db.client)).toBe(2);
  });

  test("o shutdown da aplicação espera o tick em andamento: o evento enviado é marcado antes de fechar", async () => {
    queue = await createEventsQueue();
    const publisher = countingPublisher(queue.name);
    const release = createGate();
    publisher.gate = release.opened;
    api = await startWalletApi({
      env: { APP_ROLES: "api,outbox", OUTBOX_INTERVAL_MS: "10", SQS_EVENTS_QUEUE: queue.name },
      providers: [{ token: EVENT_PUBLISHER, value: publisher }],
    });
    await openWallet(api.http, "100.00");
    await waitUntil(() => publisher.sent.length > 0, "o tick começar a enviar");

    let closed = false;
    const closing = api.app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(closed).toBe(false);

    release.open();
    await closing;

    expect(closed).toBe(true);
    const { db } = api;
    expect(await pendingCount(db.client)).toBe(0);
    await db.close();
    api = undefined;
  });
});
