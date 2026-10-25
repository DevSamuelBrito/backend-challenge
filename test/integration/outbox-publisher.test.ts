import { describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:net";
import { Logger } from "@nestjs/common";
import { EVENT_PUBLISHER } from "../../src/modules/messaging/application/event-publisher.port";
import { CLOCK } from "../../src/shared/application/clock.port";
import { FAULT_INJECTOR } from "../../src/shared/application/fault-injector.port";
import { ControlledClock } from "../support/doubles";
import {
  AT,
  countingPublisher,
  createEventsQueue,
  outboxPublisherOf,
  outboxRows,
  pendingCount,
  ScriptedFaultInjector,
  SimulatedCrash,
  seedOutbox,
} from "../support/outbox";
import { useOutbox } from "../support/outbox-scenario";
import { keyFor, openWallet, submit, wagerPayload } from "../support/wagering-api";
import { startInstance, startWalletApi } from "../support/wallet-api";

const money = (amount: string) => ({ amount, currency: "BRL" });
const SECOND = 1000;
const at = (offsetMs: number) => new Date(AT.getTime() + offsetMs);

describe("publisher da outbox: eventos de negócio chegam à fila wager-events.fifo", () => {
  const s = useOutbox();

  test("BET processada => após o tick, a fila tem os eventos com corpo, MessageGroupId (walletId) e MessageDeduplicationId (eventId) corretos", async () => {
    const wallet = await openWallet(s.api.http, "100.00");
    const payload = wagerPayload(wallet, { kind: "BET", money: money("25.00") });
    const response = await submit(s.api.http, payload, keyFor(payload));
    const { transactionId } = response.body as { transactionId: string };

    const report = await s.tick(AT);

    expect(report).toEqual({ claimed: 4, published: 4, failed: 0 });
    const received = await s.queue.drain(4);
    expect(received).toHaveLength(4);

    const stored = await s.client.query(
      "select id, event_type, payload from outbox_messages order by seq",
    );
    const storedById = new Map(
      stored.rows.map((row) => [row.id as string, row.payload as Record<string, unknown>]),
    );

    for (const event of received) {
      expect(storedById.get(event.body.eventId)).toEqual(event.body);
      expect(event.groupId).toBe(wallet.id);
      expect(event.deduplicationId).toBe(event.body.eventId);
      expect(event.attributes).toEqual({
        eventType: event.body.eventType,
        eventId: event.body.eventId,
      });
      expect(event.body.data.walletId).toBe(wallet.id);
    }

    const forBet = received.filter(
      (event) =>
        event.body.data.transactionId === transactionId || event.body.aggregateId === transactionId,
    );
    expect(forBet.map((event) => event.body.eventType)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("o group id é o walletId, NÃO o aggregate_id (que nos eventos de transação é o transactionId)", async () => {
    const wallet = await openWallet(s.api.http, "100.00");
    const payload = wagerPayload(wallet, { kind: "BET", money: money("25.00") });
    const response = await submit(s.api.http, payload, keyFor(payload));
    const { transactionId } = response.body as { transactionId: string };
    await s.tick(AT);

    const received = await s.queue.drain(4);
    const processed = received.find(
      (event) =>
        event.body.eventType === "WagerTransactionProcessed" &&
        event.body.aggregateId === transactionId,
    );

    expect(processed?.body.aggregateId).toBe(transactionId);
    expect(processed?.groupId).toBe(wallet.id);
    expect(processed?.groupId).not.toBe(transactionId);
  });

  test("eventos da mesma wallet saem na ordem de seq dentro do grupo", async () => {
    const wallet = await openWallet(s.api.http, "100.00");
    for (let index = 0; index < 3; index++) {
      const payload = wagerPayload(wallet, { kind: "BET", money: money("1.00") });
      await submit(s.api.http, payload, keyFor(payload));
    }
    const rows = await outboxRows(s.client);
    const expectedOrder = rows.filter((row) => row.published_at === null).map((row) => row.id);

    await s.tick(AT);
    await s.tick(AT);

    const received = await s.queue.drain(expectedOrder.length);
    expect(received.map((event) => event.body.eventId)).toEqual(expectedOrder);
  });

  test("as linhas ficam com published_at preenchido (no instante do tick) e attempts 0", async () => {
    const wallet = await openWallet(s.api.http, "100.00");
    const before = await outboxRows(s.client);
    const pendingIds = before.filter((row) => row.published_at === null).map((row) => row.id);

    await s.tick(at(5 * SECOND));

    const after = await outboxRows(s.client, pendingIds);
    expect(after).toHaveLength(pendingIds.length);
    for (const row of after) {
      expect(row.published_at).toEqual(at(5 * SECOND));
      expect(row.attempts).toBe(0);
    }
    expect(wallet.id).toBeDefined();
  });

  test("nada é publicado duas vezes quando não há falha: tick repetido não reenvia", async () => {
    await openWallet(s.api.http, "100.00");
    const first = await s.tick(AT);
    const sendsAfterFirst = s.publisher.sent.length;

    const second = await s.tick(AT);
    const third = await s.tick(at(60 * SECOND));

    expect(first.published).toBe(2);
    expect(second).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(third).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(s.publisher.sent).toHaveLength(sendsAfterFirst);
    expect(new Set(s.publisher.sent).size).toBe(s.publisher.sent.length);
    expect(await s.queue.drain(2)).toHaveLength(2);
    expect(await s.queue.drain()).toHaveLength(0);
  });
});

describe("publisher da outbox: só enxerga o que já foi commitado", () => {
  const s = useOutbox();

  test("com a transação de negócio aberta o tick não envia nada; depois do commit, envia", async () => {
    const wallet = await openWallet(s.api.http, "100.00");
    await s.tick(AT);
    s.publisher.reset();
    const hold = s.holdNextTransaction();
    const payload = wagerPayload(wallet, { kind: "BET", money: money("25.00") });

    const request = submit(s.api.http, payload, keyFor(payload));
    await hold.reached;
    const during = await s.tick(AT);

    expect(during).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(s.publisher.sent).toHaveLength(0);

    hold.release("commit");
    const response = await request;
    expect(response.status).toBe(200);
    const after = await s.tick(AT);

    expect(after).toMatchObject({ claimed: 2, published: 2 });
    expect(s.publisher.sent).toHaveLength(2);
    const received = await s.queue.drain(4);
    expect(received.filter((event) => event.body.data.walletId === wallet.id)).toHaveLength(4);
  });

  test("se a transação de negócio der rollback, NADA é publicado, nunca", async () => {
    const wallet = await openWallet(s.api.http, "100.00");
    await s.tick(AT);
    const outboxBefore = await outboxRows(s.client);
    s.publisher.reset();
    const hold = s.holdNextTransaction();
    const payload = wagerPayload(wallet, { kind: "BET", money: money("25.00") });

    const request = submit(s.api.http, payload, keyFor(payload));
    await hold.reached;
    expect(await s.tick(AT)).toMatchObject({ claimed: 0 });
    hold.release("rollback");
    const response = await request;

    expect(response.status).toBe(500);
    for (const now of [AT, at(10 * SECOND), at(3600 * SECOND)]) {
      expect(await s.tick(now)).toMatchObject({ claimed: 0, published: 0 });
    }
    expect(s.publisher.sent).toHaveLength(0);
    expect(await outboxRows(s.client)).toEqual(outboxBefore);
    expect(await s.queue.drain()).toHaveLength(2);
  });
});

describe("publisher da outbox: lote, ordem e SKIP LOCKED", () => {
  const s = useOutbox({ OUTBOX_BATCH_SIZE: "3" });

  test("o lote respeita OUTBOX_BATCH_SIZE e o restante fica para o tick seguinte", async () => {
    await seedOutbox(
      s.client,
      Array.from({ length: 8 }, () => ({})),
    );

    const reports = [await s.tick(AT), await s.tick(AT), await s.tick(AT), await s.tick(AT)];

    expect(reports.map((report) => report.claimed)).toEqual([3, 3, 2, 0]);
    expect(await pendingCount(s.client)).toBe(0);
  });

  test("dentro do lote, a ordem é por seq, mesmo com next_attempt_at fora de ordem", async () => {
    const ids = await seedOutbox(s.client, [
      { nextAttemptAt: at(-1 * SECOND) },
      { nextAttemptAt: at(-100 * SECOND) },
      { nextAttemptAt: at(-50 * SECOND) },
    ]);

    await s.tick(AT);

    expect(s.publisher.sent).toEqual(ids);
  });

  test("mensagem ainda não devida (next_attempt_at no futuro) não entra no lote", async () => {
    const [due, later] = await seedOutbox(s.client, [{}, { nextAttemptAt: at(30 * SECOND) }]);

    expect(await s.tick(AT)).toMatchObject({ claimed: 1, published: 1 });
    expect(s.publisher.sent).toEqual([due as string]);
    expect(await s.tick(at(30 * SECOND))).toMatchObject({ claimed: 1 });
    expect(s.publisher.sent).toEqual([due as string, later as string]);
  });

  test("mensagens já publicadas nunca voltam ao lote", async () => {
    await seedOutbox(s.client, [{ publishedAt: AT }, { publishedAt: AT }]);

    expect(await s.tick(AT)).toMatchObject({ claimed: 0 });
  });
});

describe("publisher da outbox: lote de 25 (mais que as 10 entradas do SendMessageBatch)", () => {
  const s = useOutbox({ OUTBOX_BATCH_SIZE: "25" });

  test("25 mensagens saem em 3 chamadas ao SQS e todas chegam à fila", async () => {
    const ids = await seedOutbox(
      s.client,
      Array.from({ length: 25 }, (_, index) => ({ walletId: `grupo-${index % 5}` })),
    );

    const report = await s.tick(AT);

    expect(report).toEqual({ claimed: 25, published: 25, failed: 0 });
    const received = await s.queue.drain(25);
    expect(new Set(received.map((event) => event.body.eventId))).toEqual(new Set(ids));
    expect(received).toHaveLength(25);
  });
});

describe("publisher da outbox: falhas de envio nunca perdem nem travam o lote", () => {
  const s = useOutbox();

  test("entrada com falha PARCIAL no lote: só as confirmadas são marcadas; a com problema ganha tentativa e backoff", async () => {
    const [good1, bad, good2] = await seedOutbox(s.client, [
      { walletId: "grupo-bom-1" },
      { walletId: "grupo inválido é" },
      { walletId: "grupo-bom-2" },
    ]);

    const report = await s.tick(AT);

    expect(report).toEqual({ claimed: 3, published: 2, failed: 1 });
    const rows = await outboxRows(s.client, [good1 as string, bad as string, good2 as string]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(good1 as string)?.published_at).toEqual(AT);
    expect(byId.get(good2 as string)?.published_at).toEqual(AT);
    expect(byId.get(bad as string)).toMatchObject({
      published_at: null,
      attempts: 1,
      next_attempt_at: at(1 * SECOND),
    });
    const received = await s.queue.drain(2);
    expect(received.map((event) => event.body.eventId).sort()).toEqual(
      [good1 as string, good2 as string].sort(),
    );
  });

  test("evento sem walletId (sem como definir o grupo): não é enviado, ganha tentativa e NÃO impede os outros", async () => {
    const [good, malformed] = await seedOutbox(s.client, [{}, { walletId: null }]);

    const report = await s.tick(AT);

    expect(report).toEqual({ claimed: 2, published: 1, failed: 1 });
    expect(s.publisher.sent).toEqual([good as string]);
    const rows = await outboxRows(s.client, [malformed as string]);
    expect(rows[0]).toMatchObject({ published_at: null, attempts: 1 });
  });

  test("o backoff do SQS com erro segue 1s, 2s, 4s... até o teto de 60s, e a mensagem nunca é descartada", async () => {
    const [id] = await seedOutbox(s.client, [{ walletId: "grupo inválido é" }]);
    const expectedDelays = [1, 2, 4, 8, 16, 32, 60, 60, 60];
    let now = AT;

    for (const [index, seconds] of expectedDelays.entries()) {
      const report = await s.tick(now);
      expect(report).toMatchObject({ claimed: 1, failed: 1 });
      const [row] = await outboxRows(s.client, [id as string]);
      expect(row?.attempts).toBe(index + 1);
      expect(row?.published_at).toBeNull();
      expect(row?.next_attempt_at).toEqual(new Date(now.getTime() + seconds * SECOND));
      expect(await s.tick(new Date(now.getTime() + seconds * SECOND - 1))).toMatchObject({
        claimed: 0,
      });
      now = new Date(now.getTime() + seconds * SECOND);
    }
  });

  test("mensagem com muitas falhas (attempts 500) continua sendo tentada e publica quando o problema some", async () => {
    const [id] = await seedOutbox(s.client, [{ attempts: 500 }]);

    const report = await s.tick(AT);

    expect(report).toMatchObject({ claimed: 1, published: 1 });
    const [row] = await outboxRows(s.client, [id as string]);
    expect(row?.published_at).toEqual(AT);
    expect(row?.attempts).toBe(500);
  });

  test("alerta warn só quando attempts passa do limiar (padrão 10)", async () => {
    const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const [early, late] = await seedOutbox(s.client, [
        { attempts: 8, walletId: "grupo inválido é" },
        { attempts: 10, walletId: "grupo inválido é" },
      ]);

      await s.tick(AT);

      const logged = warn.mock.calls.map((call) => call[0] as Record<string, unknown>);
      expect(logged.some((entry) => entry.eventId === late)).toBe(true);
      expect(logged.some((entry) => entry.eventId === early)).toBe(false);
      expect(logged.find((entry) => entry.eventId === late)).toMatchObject({ attempts: 11 });
    } finally {
      warn.mockRestore();
    }
  });

  test("SQS fora do ar => attempts sobe, nada se perde; ao voltar, o evento é publicado e marcado", async () => {
    const [id] = await seedOutbox(s.client, [{}]);
    const broken = await startInstance(s.api.db, {
      env: { APP_ROLES: "api", SQS_ENDPOINT: "http://127.0.0.1:9", OUTBOX_SEND_TIMEOUT_MS: "800" },
      providers: [{ token: CLOCK, value: new ControlledClock(AT) }],
    });

    try {
      const down = await outboxPublisherOf(broken).tick(AT);
      expect(down).toEqual({ claimed: 1, published: 0, failed: 1 });
      const [row] = await outboxRows(s.client, [id as string]);
      expect(row).toMatchObject({
        attempts: 1,
        published_at: null,
        next_attempt_at: at(1 * SECOND),
      });
    } finally {
      await broken.close();
    }

    expect(await s.tick(AT)).toMatchObject({ claimed: 0 });
    const back = await s.tick(at(1 * SECOND));

    expect(back).toMatchObject({ claimed: 1, published: 1 });
    expect((await outboxRows(s.client, [id as string]))[0]?.published_at).toEqual(at(1 * SECOND));
    expect(await s.queue.drain(1)).toHaveLength(1);
  });

  test("a fila de eventos ainda não existe => falha com backoff; depois de criada, publica", async () => {
    const lateQueue = await createEventsQueue({ create: false });
    const api = await startWalletApi({
      env: { APP_ROLES: "api", SQS_EVENTS_QUEUE: lateQueue.name },
      providers: [{ token: CLOCK, value: new ControlledClock(AT) }],
    });

    try {
      const [id] = await seedOutbox(api.db.client, [{}]);

      expect(await outboxPublisherOf(api).tick(AT)).toMatchObject({ failed: 1, published: 0 });
      expect((await outboxRows(api.db.client, [id as string]))[0]).toMatchObject({
        attempts: 1,
        published_at: null,
      });

      await lateQueue.create();
      const report = await outboxPublisherOf(api).tick(at(1 * SECOND));

      expect(report).toMatchObject({ claimed: 1, published: 1 });
      expect(await lateQueue.drain(1)).toHaveLength(1);
    } finally {
      await api.close();
      await lateQueue.close();
    }
  });

  test("timeout curto no SDK: um SQS que aceita a conexão e nunca responde não segura a transação", async () => {
    const [id] = await seedOutbox(s.client, [{}]);
    const sockets: import("node:net").Socket[] = [];
    const silent = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as import("node:net").AddressInfo;
    const hanging = await startInstance(s.api.db, {
      env: {
        APP_ROLES: "api",
        SQS_ENDPOINT: `http://127.0.0.1:${port}`,
        OUTBOX_SEND_TIMEOUT_MS: "500",
      },
      providers: [{ token: CLOCK, value: new ControlledClock(AT) }],
    });

    try {
      const startedAt = performance.now();
      const report = await outboxPublisherOf(hanging).tick(AT);
      const elapsedMs = performance.now() - startedAt;

      expect(report).toMatchObject({ claimed: 1, published: 0, failed: 1 });
      expect(elapsedMs).toBeLessThan(5000);
      expect((await outboxRows(s.client, [id as string]))[0]?.attempts).toBe(1);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await hanging.close();
      await new Promise((resolve) => silent.close(resolve));
    }
  });
});

describe("publisher da outbox: morte entre o envio e a marcação (FaultInjector)", () => {
  const s = useOutbox();

  test("a linha continua pendente; um novo tick REENVIA (2 envios) e marca; a fila FIFO esconde o duplicado", async () => {
    const ids = await seedOutbox(s.client, [{ walletId: "grupo-a" }, { walletId: "grupo-b" }]);
    s.faults.armCrash("outbox.after_send_before_mark");

    await expect(s.tick(AT)).rejects.toBeInstanceOf(SimulatedCrash);

    expect(s.faults.reached).toEqual(["outbox.after_send_before_mark"]);
    for (const row of await outboxRows(s.client, ids)) {
      expect(row).toMatchObject({ published_at: null, attempts: 0 });
    }
    expect(await pendingCount(s.client)).toBe(2);
    for (const id of ids) {
      expect(s.publisher.sendsOf(id)).toBe(1);
    }

    const recovery = await s.tick(at(1 * SECOND));

    expect(recovery).toEqual({ claimed: 2, published: 2, failed: 0 });
    for (const id of ids) {
      expect(s.publisher.sendsOf(id)).toBe(2);
    }
    expect(await pendingCount(s.client)).toBe(0);
    const received = await s.queue.drain();
    expect(received.map((event) => event.body.eventId).sort()).toEqual([...ids].sort());
  });

  test("a morte não consome tentativa nem agenda backoff: a mensagem segue devida", async () => {
    const [id] = await seedOutbox(s.client, [{}]);
    s.faults.armCrash("outbox.after_send_before_mark");

    await expect(s.tick(AT)).rejects.toBeInstanceOf(SimulatedCrash);

    const [row] = await outboxRows(s.client, [id as string]);
    expect(row).toMatchObject({ attempts: 0, published_at: null, next_attempt_at: AT });
    expect(await s.tick(AT)).toMatchObject({ claimed: 1, published: 1 });
  });
});

describe("publisher da outbox: recuperação após reinício", () => {
  const s = useOutbox();

  test("mensagens pendentes de uma instância que morreu no meio do tick são publicadas por uma instância nova", async () => {
    const ids = await seedOutbox(
      s.client,
      Array.from({ length: 5 }, () => ({})),
    );
    const dyingFaults = new ScriptedFaultInjector();
    dyingFaults.armCrash("outbox.after_send_before_mark");
    const dying = await startInstance(s.api.db, {
      env: { APP_ROLES: "api", SQS_EVENTS_QUEUE: s.queue.name },
      providers: [
        { token: CLOCK, value: new ControlledClock(AT) },
        { token: EVENT_PUBLISHER, value: countingPublisher(s.queue.name) },
        { token: FAULT_INJECTOR, value: dyingFaults },
      ],
    });

    await expect(outboxPublisherOf(dying).tick(AT)).rejects.toBeInstanceOf(SimulatedCrash);
    await dying.close();
    expect(await pendingCount(s.client)).toBe(5);

    const reborn = await startInstance(s.api.db, {
      env: { APP_ROLES: "api", SQS_EVENTS_QUEUE: s.queue.name },
      providers: [{ token: CLOCK, value: new ControlledClock(AT) }],
    });

    try {
      const report = await outboxPublisherOf(reborn).tick(at(1 * SECOND));

      expect(report).toMatchObject({ claimed: 5, published: 5 });
    } finally {
      await reborn.close();
    }

    expect(await pendingCount(s.client)).toBe(0);
    const received = await s.queue.drain(5);
    expect(received.map((event) => event.body.eventId).sort()).toEqual([...ids].sort());
  });
});

describe("publisher da outbox: o limiar do alerta vem da configuração", () => {
  const s = useOutbox({ OUTBOX_ALERT_ATTEMPTS: "2" });

  test("com OUTBOX_ALERT_ATTEMPTS=2, a 3ª tentativa que falha já gera o warn", async () => {
    const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const [id] = await seedOutbox(s.client, [{ attempts: 2, walletId: "grupo inválido é" }]);

      await s.tick(AT);

      const logged = warn.mock.calls.map((call) => call[0] as Record<string, unknown>);
      expect(logged.find((entry) => entry.eventId === id)).toMatchObject({ attempts: 3 });
    } finally {
      warn.mockRestore();
    }
  });
});
