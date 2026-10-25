import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Client } from "pg";
import { DeadLetterMonitorScheduler } from "../../src/modules/messaging/infrastructure/dead-letter-monitor.scheduler";
import { waitUntil } from "../support/async";
import { useConsumer } from "../support/consumer-scenario";
import { metricValue, scrape } from "../support/observability";

setDefaultTimeout(60_000);

const consumer = useConsumer(
  {
    CONSUMER_BACKOFF_BASE_SECONDS: "1",
    CONSUMER_BACKOFF_MAX_SECONDS: "1",
    DLQ_MONITOR_INTERVAL_MS: "200",
  },
  { lockTimeoutMs: 200 },
);

let holder: Client | undefined;

afterEach(async () => {
  await consumer.api.app.get(DeadLetterMonitorScheduler, { strict: false }).stop();
  await holder?.query("rollback").catch(() => undefined);
  await holder?.end().catch(() => undefined);
  holder = undefined;
});

const dlqGauge = async () => metricValue(await scrape(consumer.api.http), "wager_dlq_messages");

describe("gauge wager_dlq_messages", () => {
  test("o gauge existe e começa em 0 com a DLQ vazia", async () => {
    consumer.api.app.get(DeadLetterMonitorScheduler, { strict: false }).start();

    await waitUntil(
      async () => (await scrape(consumer.api.http)).includes("wager_dlq_messages 0"),
      "a primeira leitura da DLQ",
    );
    expect(await dlqGauge()).toBe(0);
  });

  test("depois que o SQS esgota as tentativas de uma mensagem e a leva para a DLQ, o gauge sobe", async () => {
    const wallet = await consumer.wallet("100.00");
    await consumer.send(consumer.payload(wallet, { money: { amount: "30.00", currency: "BRL" } }));
    holder = await consumer.api.db.connect();
    await holder.query("begin");
    await holder.query("select id from wallets where id = $1 for update", [wallet.id]);

    consumer.api.app.get(DeadLetterMonitorScheduler, { strict: false }).start();
    expect(await dlqGauge()).toBe(0);

    consumer.start();
    await waitUntil(
      async () => (await dlqGauge()) >= 1,
      "o gauge da DLQ chegar a 1 depois do redrive do SQS",
      45_000,
    );

    expect(await consumer.queues.dlqDepth()).toBeGreaterThanOrEqual(1);
    expect(consumer.queue.deadLettered).toHaveLength(0);
  });
});
