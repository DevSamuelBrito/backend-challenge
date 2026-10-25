import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Client } from "pg";
import { waitUntil } from "../support/async";
import { MAX_RECEIVE_COUNT } from "../support/consumer";
import { useConsumer } from "../support/consumer-scenario";

setDefaultTimeout(60_000);

const consumer = useConsumer(
  { CONSUMER_BACKOFF_BASE_SECONDS: "1", CONSUMER_BACKOFF_MAX_SECONDS: "1" },
  { lockTimeoutMs: 200 },
);

let holder: Client | undefined;

afterEach(async () => {
  if (holder) {
    await holder.query("rollback").catch(() => undefined);
    await holder.end().catch(() => undefined);
    holder = undefined;
  }
});

describe("consumidor SQS: esgotar as tentativas", () => {
  test("erro transitório que nunca passa: depois de maxReceiveCount o SQS leva a mensagem para a DLQ, sem efeito", async () => {
    const wallet = await consumer.wallet("100.00");
    const message = await consumer.send(
      consumer.payload(wallet, { money: { amount: "30.00", currency: "BRL" } }),
    );
    holder = await consumer.api.db.connect();
    await holder.query("begin");
    await holder.query("select id from wallets where id = $1 for update", [wallet.id]);
    const baseline = await consumer.counts();

    consumer.start();
    await waitUntil(
      async () => (await consumer.queues.dlqDepth()) >= 1,
      "o SQS mover a mensagem para a DLQ",
      45_000,
    );

    const deadLetters = await consumer.queues.drainDlq(1);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.rawBody).toMatchObject({ messageId: message.messageId });
    expect(deadLetters[0]?.failureReason).toBeUndefined();
    expect(consumer.queue.received.map((entry) => entry.receiveCount)).toEqual(
      Array.from({ length: MAX_RECEIVE_COUNT }, (_, index) => index + 1),
    );
    expect(consumer.queue.deadLettered).toHaveLength(0);
    expect(consumer.queue.deleted).toHaveLength(0);
    expect(await consumer.queues.inputDepth()).toBe(0);
    expect(await consumer.counts()).toEqual(baseline);
    expect(await consumer.balance(wallet)).toBe("100.00");
    expect(await consumer.inboxCount(message.messageId)).toBe(0);
  });
});
