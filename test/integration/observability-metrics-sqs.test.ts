import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { waitUntil } from "../support/async";
import { useConsumer } from "../support/consumer-scenario";
import { metricValue, scrape } from "../support/observability";

setDefaultTimeout(40_000);

const money = (amount: string) => ({ amount, currency: "BRL" });

const consumer = useConsumer({}, { lockTimeoutMs: 300 });

let holder: Client | undefined;

afterEach(async () => {
  await holder?.query("rollback").catch(() => undefined);
  await holder?.end().catch(() => undefined);
  holder = undefined;
});

const metrics = () => scrape(consumer.api.http);

describe("métricas do consumidor SQS", () => {
  test("uma BET pela fila soma em transações e na latência da origem sqs", async () => {
    const wallet = await consumer.wallet("100.00");
    const before = await metrics();
    await consumer.send(consumer.payload(wallet, { money: money("10.00") }));

    consumer.start();
    await consumer.settled();
    const after = await metrics();

    expect(
      metricValue(after, "wager_transactions_total", { kind: "BET", status: "PROCESSED" }) -
        metricValue(before, "wager_transactions_total", { kind: "BET", status: "PROCESSED" }),
    ).toBe(1);
    expect(
      metricValue(after, "wager_processing_duration_seconds_count", { source: "sqs" }) -
        metricValue(before, "wager_processing_duration_seconds_count", { source: "sqs" }),
    ).toBe(1);
  });

  test("mensagem já vista no inbox soma como duplicata do tipo inbox_message", async () => {
    const wallet = await consumer.wallet("100.00");
    const payload = consumer.payload(wallet, { money: money("10.00") });
    const messageId = `msg-${randomUUID()}`;
    await consumer.send(payload, { messageId });
    await consumer.send(payload, { messageId }, { deduplicationId: randomUUID() });
    const before = await metrics();

    consumer.start();
    await consumer.settled();
    const after = await metrics();

    expect(
      metricValue(after, "wager_duplicates_total", { type: "inbox_message", source: "sqs" }) -
        metricValue(before, "wager_duplicates_total", { type: "inbox_message", source: "sqs" }),
    ).toBe(1);
    expect(
      metricValue(after, "wager_transactions_total", { kind: "BET", status: "PROCESSED" }) -
        metricValue(before, "wager_transactions_total", { kind: "BET", status: "PROCESSED" }),
    ).toBe(1);
  });

  test("replay de idempotência pela fila (outro messageId) soma como idempotent_replay de sqs", async () => {
    const wallet = await consumer.wallet("100.00");
    const payload = consumer.payload(wallet, { money: money("10.00") });
    await consumer.send(payload);
    await consumer.send(payload);
    const before = await metrics();

    consumer.start();
    await consumer.settled();
    const after = await metrics();

    expect(
      metricValue(after, "wager_duplicates_total", { type: "idempotent_replay", source: "sqs" }) -
        metricValue(before, "wager_duplicates_total", { type: "idempotent_replay", source: "sqs" }),
    ).toBe(1);
  });

  test("mensagem enviada explicitamente à DLQ soma por motivo", async () => {
    const wallet = await consumer.wallet("100.00");
    const before = await metrics();
    await consumer.queues.send("{quebrado", { groupId: wallet.id, deduplicationId: randomUUID() });
    await consumer.queues.send(
      consumer.message(consumer.payload(wallet, { walletId: randomUUID() })),
      { groupId: wallet.id, deduplicationId: randomUUID() },
    );

    consumer.start();
    await consumer.settled();
    const after = await metrics();

    expect(
      metricValue(after, "wager_dead_letter_total", { reason: "MALFORMED_MESSAGE" }) -
        metricValue(before, "wager_dead_letter_total", { reason: "MALFORMED_MESSAGE" }),
    ).toBe(1);
    expect(
      metricValue(after, "wager_dead_letter_total", { reason: "WALLET_NOT_FOUND" }) -
        metricValue(before, "wager_dead_letter_total", { reason: "WALLET_NOT_FOUND" }),
    ).toBe(1);
  });

  test("erro transitório soma retries do consumidor e o lock timeout soma em conflitos de lock", async () => {
    const wallet = await consumer.wallet("100.00");
    await consumer.send(consumer.payload(wallet, { money: money("10.00") }));
    holder = await consumer.api.db.connect();
    await holder.query("begin");
    await holder.query("select id from wallets where id = $1 for update", [wallet.id]);
    const before = await metrics();

    consumer.start();
    await waitUntil(
      async () =>
        metricValue(await metrics(), "wager_retries_total", { source: "consumer" }) >
        metricValue(before, "wager_retries_total", { source: "consumer" }),
      "o primeiro retry do consumidor",
      20_000,
    );
    const during = await metrics();
    await holder.query("rollback");
    await consumer.settled();

    expect(
      metricValue(during, "wager_lock_timeouts_total") -
        metricValue(before, "wager_lock_timeouts_total"),
    ).toBeGreaterThanOrEqual(1);
    expect(await consumer.balance(wallet)).toBe("90.00");
  });
});
