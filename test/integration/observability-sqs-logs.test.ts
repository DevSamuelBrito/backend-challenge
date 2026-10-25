import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Client } from "pg";
import { waitUntil } from "../support/async";
import { useConsumer } from "../support/consumer-scenario";
import { LogCapture } from "../support/observability";
import { eventsOfTransaction } from "../support/wagering-api";

setDefaultTimeout(40_000);

const money = (amount: string) => ({ amount, currency: "BRL" });

const capture = new LogCapture();
const consumer = useConsumer({}, { lockTimeoutMs: 300 }, capture);

let holder: Client | undefined;

beforeEach(() => {
  capture.clear();
});

afterEach(async () => {
  await holder?.query("rollback").catch(() => undefined);
  await holder?.end().catch(() => undefined);
  holder = undefined;
});

const correlationsOfEvents = async (wallet: Parameters<typeof consumer.transactionsOf>[0]) => {
  const [transaction] = await consumer.transactionsOf(wallet);

  return new Set(
    (await eventsOfTransaction(consumer.client, transaction?.id as string)).map(
      (event) => (event.payload as unknown as { correlationId: string }).correlationId,
    ),
  );
};

describe("correlação pela fila SQS", () => {
  test("usa o atributo correlationId da mensagem nos logs e nos eventos, e põe o messageId no contexto", async () => {
    const wallet = await consumer.wallet("100.00");
    capture.clear();
    const message = await consumer.send(
      consumer.payload(wallet, { money: money("10.00") }),
      {},
      { attributes: { correlationId: "corr-do-atributo" } },
    );

    consumer.start();
    await consumer.settled();

    expect(await correlationsOfEvents(wallet)).toEqual(new Set(["corr-do-atributo"]));
    expect(capture.events("wager.processed")[0]).toMatchObject({
      correlationId: "corr-do-atributo",
      messageId: message.messageId,
      walletId: wallet.id,
      providerId: "provider-a",
      kind: "BET",
      status: "PROCESSED",
      source: "sqs",
    });
  });

  test("sem atributo, o correlationId é o messageId", async () => {
    const wallet = await consumer.wallet("100.00");
    capture.clear();
    const message = await consumer.send(consumer.payload(wallet, { money: money("10.00") }));

    consumer.start();
    await consumer.settled();

    expect(await correlationsOfEvents(wallet)).toEqual(new Set([message.messageId]));
    expect(capture.events("wager.processed")[0]).toMatchObject({
      correlationId: message.messageId,
      messageId: message.messageId,
    });
  });

  test("atributo inválido é ignorado e vale o messageId", async () => {
    const wallet = await consumer.wallet("100.00");
    const message = await consumer.send(
      consumer.payload(wallet, { money: money("10.00") }),
      {},
      { attributes: { correlationId: "tem espaço" } },
    );

    consumer.start();
    await consumer.settled();

    expect(await correlationsOfEvents(wallet)).toEqual(new Set([message.messageId]));
  });

  test("o log da DLQ de uma mensagem válida mas rejeitada carrega messageId e correlationId", async () => {
    const wallet = await consumer.wallet("100.00");
    capture.clear();
    const message = consumer.message(consumer.payload(wallet, { walletId: randomUUID() }));
    await consumer.queues.send(message, {
      groupId: wallet.id,
      attributes: { correlationId: "corr-dlq-1" },
    });

    consumer.start();
    await consumer.settled();

    expect(capture.events("consumer.dead_letter")[0]).toMatchObject({
      reason: "WALLET_NOT_FOUND",
      correlationId: "corr-dlq-1",
      messageId: message.messageId,
    });
  });

  test("mensagem malformada ainda sai com um correlationId (o id da mensagem no SQS)", async () => {
    const wallet = await consumer.wallet("100.00");
    capture.clear();
    await consumer.queues.send("{quebrado", { groupId: wallet.id, deduplicationId: randomUUID() });

    consumer.start();
    await consumer.settled();

    const line = capture.events("consumer.dead_letter")[0];
    expect(line).toMatchObject({ reason: "MALFORMED_MESSAGE" });
    expect(typeof line?.correlationId).toBe("string");
    expect(line).not.toHaveProperty("messageId");
  });

  test("o retry de um erro transitório é logado com correlação e sem a mensagem do erro", async () => {
    const wallet = await consumer.wallet("100.00");
    capture.clear();
    const message = await consumer.send(consumer.payload(wallet, { money: money("10.00") }));
    holder = await consumer.api.db.connect();
    await holder.query("begin");
    await holder.query("select id from wallets where id = $1 for update", [wallet.id]);

    consumer.start();
    await waitUntil(
      () => capture.events("consumer.transient_failure").length > 0,
      "o primeiro retry",
      20_000,
    );
    await holder.query("rollback");
    await consumer.settled();

    expect(capture.events("consumer.transient_failure")[0]).toMatchObject({
      reason: "LOCK_TIMEOUT",
      messageId: message.messageId,
      walletId: wallet.id,
      receiveCount: 1,
      retryInSeconds: 1,
    });
  });
});

describe("prova de não vazamento: nenhum log traz valor, payload ou Idempotency-Key", () => {
  const AMOUNT = "123456.78";
  const REJECTED_AMOUNT = "654321.09";
  const CONFLICT_AMOUNT = "777777.77";
  const INVALID_AMOUNT = "123456.789";
  const HTTP_KEY = "idem-secret-http-key-7f3a";
  const SQS_KEY = "idem-secret-sqs-key-91bc";

  test("wallet, BET, replay, rejeição, conflito, payload inválido, fila inválida, retry e reconciliação divergente", async () => {
    const wallet = await consumer.wallet("500000.00");
    const bet = consumer.payload(wallet, { money: money(AMOUNT) });
    const post = (body: unknown, key: string) =>
      consumer.api.http.post("/wagering/transactions", body, { "Idempotency-Key": key });

    expect((await post(bet, HTTP_KEY)).status).toBe(200);
    expect((await post(bet, HTTP_KEY)).status).toBe(200);
    expect(
      (await post(consumer.payload(wallet, { money: money(REJECTED_AMOUNT) }), randomUUID()))
        .status,
    ).toBe(422);
    expect((await post({ ...bet, money: money(CONFLICT_AMOUNT) }, HTTP_KEY)).status).toBe(409);
    expect(
      (await post({ ...bet, money: money(INVALID_AMOUNT) }, `${HTTP_KEY}-invalid`)).status,
    ).toBe(400);
    expect((await consumer.api.http.post("/wagering/transactions", bet, {})).status).toBe(400);

    await consumer.queues.send(
      consumer.message(consumer.payload(wallet, { money: money(INVALID_AMOUNT) }), {
        idempotencyKey: SQS_KEY,
      }),
      { groupId: wallet.id },
    );
    await consumer.send(
      consumer.payload(wallet, { money: money(AMOUNT), walletId: randomUUID() }),
      { idempotencyKey: SQS_KEY },
      { groupId: wallet.id },
    );
    await consumer.send(
      consumer.payload(wallet, { money: money(AMOUNT) }),
      { idempotencyKey: `${SQS_KEY}-valid` },
      { groupId: wallet.id },
    );
    await consumer.send(
      consumer.payload(wallet, {
        kind: "REFUND",
        money: money(AMOUNT),
        referenceExternalTransactionId: "nao-chegou",
      }),
      { idempotencyKey: `${SQS_KEY}-pending` },
      { groupId: wallet.id },
    );

    holder = await consumer.api.db.connect();
    await holder.query("begin");
    await holder.query("select id from wallets where id = $1 for update", [wallet.id]);
    consumer.start();
    await waitUntil(
      () => capture.events("consumer.transient_failure").length > 0,
      "um retry por lock",
      20_000,
    );
    await holder.query("rollback");
    await consumer.settled();

    const error = spyOn(Logger.prototype, "error");
    await consumer.client.query("update wallets set balance = 1.00 where id = $1", [wallet.id]);
    try {
      const result = await consumer.api.http.post(`/wallets/${wallet.id}/reconciliation`, {});
      expect((result.body as { consistent: boolean }).consistent).toBe(false);
    } finally {
      error.mockRestore();
      await consumer.client.query(
        "update wallets set balance = (select balance_after from wallet_ledger_entries where wallet_id = $1 order by wallet_version desc limit 1) where id = $1",
        [wallet.id],
      );
    }

    const everything = capture.raw.join("\n");
    expect(capture.lines.length).toBeGreaterThan(10);

    for (const secret of [
      AMOUNT,
      REJECTED_AMOUNT,
      CONFLICT_AMOUNT,
      INVALID_AMOUNT,
      "500000",
      "376543",
      HTTP_KEY,
      SQS_KEY,
      "idem-secret",
    ]) {
      expect(everything).not.toContain(secret);
    }
    for (const forbidden of [
      '"amount"',
      '"money"',
      '"balance"',
      '"idempotencyKey"',
      "Idempotency-Key",
    ]) {
      expect(everything).not.toContain(forbidden);
    }

    const seen = new Set(capture.lines.map((line) => line.event));
    for (const event of [
      "http.request",
      "wager.processed",
      "wager.replay",
      "consumer.dead_letter",
      "consumer.transient_failure",
      "wallet.reconciliation_mismatch",
    ]) {
      expect(seen.has(event)).toBe(true);
    }
  });

  test("os logs relevantes carregam os campos de correlação", async () => {
    const wallet = await consumer.wallet("100.00");
    capture.clear();
    await consumer.api.http.post(
      "/wagering/transactions",
      consumer.payload(wallet, { money: money("10.00") }),
      { "Idempotency-Key": randomUUID(), "X-Correlation-Id": "campos-1" },
    );
    await consumer.api.http.post(`/wallets/${wallet.id}/reconciliation`, {});

    for (const line of capture.events("wager.processed")) {
      for (const field of ["correlationId", "walletId", "providerId", "transactionId"]) {
        expect(line).toHaveProperty(field);
      }
    }
    expect(
      capture.events("http.request").every((line) => typeof line.correlationId === "string"),
    ).toBe(true);
  });
});
