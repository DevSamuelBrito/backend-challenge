import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { waitUntil } from "../support/async";
import { useConsumer } from "../support/consumer-scenario";
import { type FaultPlan, faultyUnitOfWork, INJECTED_FAILURE } from "../support/fault-injection";
import { workerOf } from "../support/pending-worker";
import type { TableCounts } from "../support/table-counts";
import { keyFor, submit, submitWithDefaultKey } from "../support/wagering-api";

setDefaultTimeout(40_000);

const money = (amount: string) => ({ amount, currency: "BRL" });

const plan: FaultPlan = {};
const afterFailure: TableCounts[] = [];

const consumer = useConsumer(
  {},
  {
    wrapUnitOfWork: (real) => {
      const faulty = faultyUnitOfWork(real, plan);

      return {
        run: async (work) => {
          try {
            return await faulty.run(work);
          } catch (error) {
            if (String(error).includes(INJECTED_FAILURE)) {
              afterFailure.push(await consumer.counts());
            }

            throw error;
          }
        },
      };
    },
  },
);

describe("consumidor SQS: as mesmas regras do HTTP", () => {
  test("BET pela fila: saldo, ledger, eventos na outbox e mensagem removida", async () => {
    const wallet = await consumer.wallet("100.00");
    const message = await consumer.send(consumer.payload(wallet, { money: money("30.00") }));

    consumer.start();
    await consumer.settled();

    expect(await consumer.balance(wallet)).toBe("70.00");
    expect(await consumer.movements(wallet)).toEqual([
      { direction: "DEBIT", amount: "30.00", balanceAfter: "70.00" },
    ]);
    const [transaction] = await consumer.transactionsOf(wallet);
    expect(transaction).toMatchObject({ kind: "BET", status: "PROCESSED", failure_code: null });
    expect(await consumer.eventTypes(transaction?.id as string)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    expect(await consumer.inboxCount(message.messageId)).toBe(1);
    const { rows } = await consumer.client.query(
      "select processed_at from inbox_messages where message_id = $1",
      [message.messageId],
    );
    expect(rows[0].processed_at).not.toBeNull();
    expect(consumer.queue.deleted).toHaveLength(1);
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });

  test("WIN referenciando a BET credita o prêmio", async () => {
    const wallet = await consumer.wallet("100.00");
    const bet = consumer.payload(wallet, { money: money("20.00") });
    await consumer.send(bet);
    await consumer.send(
      consumer.payload(wallet, {
        kind: "WIN",
        money: money("50.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    consumer.start();
    await consumer.settled();

    expect(await consumer.movements(wallet)).toEqual([
      { direction: "DEBIT", amount: "20.00", balanceAfter: "80.00" },
      { direction: "CREDIT", amount: "50.00", balanceAfter: "130.00" },
    ]);
  });

  test("LOSS não mexe no saldo e a mensagem é confirmada", async () => {
    const wallet = await consumer.wallet("100.00");
    await consumer.send(consumer.payload(wallet, { kind: "LOSS", money: money("40.00") }));

    consumer.start();
    await consumer.settled();

    expect(await consumer.balance(wallet)).toBe("100.00");
    expect(await consumer.movements(wallet)).toEqual([]);
    expect((await consumer.transactionsOf(wallet))[0]).toMatchObject({
      kind: "LOSS",
      status: "PROCESSED",
    });
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });

  test("REFUND reverte a BET e devolve o valor", async () => {
    const wallet = await consumer.wallet("100.00");
    const bet = consumer.payload(wallet, { money: money("25.00") });
    await consumer.send(bet);
    await consumer.send(
      consumer.payload(wallet, {
        kind: "REFUND",
        money: money("25.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    consumer.start();
    await consumer.settled();

    expect(await consumer.balance(wallet)).toBe("100.00");
    expect((await consumer.transactionsOf(wallet)).map((t) => [t.kind, t.status])).toEqual([
      ["BET", "PROCESSED"],
      ["REFUND", "PROCESSED"],
    ]);
  });

  test("ROLLBACK de referência desconhecida fica PENDING_REFERENCE, com um único evento, e a mensagem é confirmada", async () => {
    const wallet = await consumer.wallet("100.00");
    await consumer.send(
      consumer.payload(wallet, {
        kind: "ROLLBACK",
        money: money("10.00"),
        referenceExternalTransactionId: "ainda-nao-chegou",
      }),
    );

    consumer.start();
    await consumer.settled();

    const [transaction] = await consumer.transactionsOf(wallet);
    expect(transaction).toMatchObject({ kind: "ROLLBACK", status: "PENDING_REFERENCE" });
    expect(await consumer.eventTypes(transaction?.id as string)).toEqual([
      "WagerTransactionPendingReference",
    ]);
    expect(await consumer.balance(wallet)).toBe("100.00");
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });

  test("REJECTED por saldo é terminal: persistida, confirmada e fora da DLQ", async () => {
    const wallet = await consumer.wallet("100.00");
    const message = await consumer.send(consumer.payload(wallet, { money: money("500.00") }));

    consumer.start();
    await consumer.settled();

    const [transaction] = await consumer.transactionsOf(wallet);
    expect(transaction).toMatchObject({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    expect(await consumer.eventTypes(transaction?.id as string)).toEqual([
      "WagerTransactionRejected",
    ]);
    expect(await consumer.balance(wallet)).toBe("100.00");
    expect(await consumer.inboxCount(message.messageId)).toBe(1);
    expect(consumer.queue.deleted).toHaveLength(1);
    expect(consumer.queue.deadLettered).toHaveLength(0);
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });
});

describe("consumidor SQS: redelivery e replay", () => {
  test("a mesma mensagem (mesmo messageId) entregue 2 vezes tem um único efeito e as duas são confirmadas", async () => {
    const wallet = await consumer.wallet("100.00");
    const payload = consumer.payload(wallet, { money: money("30.00") });
    const messageId = `msg-${randomUUID()}`;
    await consumer.send(payload, { messageId });
    await consumer.send(payload, { messageId }, { deduplicationId: randomUUID() });

    consumer.start();
    await consumer.settled();

    expect(await consumer.balance(wallet)).toBe("70.00");
    expect(await consumer.transactionsOf(wallet)).toHaveLength(1);
    expect(await consumer.movements(wallet)).toHaveLength(1);
    expect(await consumer.inboxCount(messageId)).toBe(1);
    expect(consumer.queue.deleted).toHaveLength(2);
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });

  test("a mesma mensagem 50 vezes em paralelo (grupos diferentes) tem um único efeito e todas são confirmadas", async () => {
    const wallet = await consumer.wallet("100.00");
    const payload = consumer.payload(wallet, { money: money("30.00") });
    const messageId = `msg-${randomUUID()}`;
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        consumer.send(
          payload,
          { messageId },
          { groupId: `grupo-${index}`, deduplicationId: randomUUID() },
        ),
      ),
    );

    consumer.start();
    await consumer.settled();

    expect(await consumer.balance(wallet)).toBe("70.00");
    expect(await consumer.transactionsOf(wallet)).toHaveLength(1);
    expect(await consumer.movements(wallet)).toHaveLength(1);
    expect(await consumer.inboxCount(messageId)).toBe(1);
    expect(consumer.queue.deleted).toHaveLength(50);
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });

  test("outro messageId com a mesma chave e o mesmo conteúdo é replay: um efeito, sem erro", async () => {
    const wallet = await consumer.wallet("100.00");
    const payload = consumer.payload(wallet, { money: money("30.00") });
    const first = await consumer.send(payload);
    const second = await consumer.send(payload);

    consumer.start();
    await consumer.settled();

    expect(first.messageId).not.toBe(second.messageId);
    expect(await consumer.balance(wallet)).toBe("70.00");
    expect(await consumer.transactionsOf(wallet)).toHaveLength(1);
    expect(await consumer.inboxCount(first.messageId)).toBe(1);
    expect(await consumer.inboxCount(second.messageId)).toBe(1);
    expect(await consumer.queues.dlqDepth()).toBe(0);
    expect(consumer.queue.deleted).toHaveLength(2);
  });

  test("HTTP e depois SQS com o mesmo conteúdo: a mensagem é replay, sem segundo débito", async () => {
    const wallet = await consumer.wallet("100.00");
    const payload = consumer.payload(wallet, { money: money("30.00") });
    const http = await submitWithDefaultKey(consumer.api.http, payload);
    expect(http.status).toBe(200);

    await consumer.send(payload);
    consumer.start();
    await consumer.settled();

    expect(await consumer.balance(wallet)).toBe("70.00");
    expect(await consumer.transactionsOf(wallet)).toHaveLength(1);
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });

  test("SQS e depois HTTP com o mesmo conteúdo: o HTTP é replay da transação criada pela fila", async () => {
    const wallet = await consumer.wallet("100.00");
    const payload = consumer.payload(wallet, { money: money("30.00") });
    await consumer.send(payload);
    consumer.start();
    await consumer.settled();
    const [created] = await consumer.transactionsOf(wallet);

    const http = await submit(consumer.api.http, payload, keyFor(payload));

    expect(http.status).toBe(200);
    expect(http.body).toMatchObject({
      idempotentReplay: true,
      transactionId: created?.id,
      status: "PROCESSED",
    });
    expect(await consumer.balance(wallet)).toBe("70.00");
    expect(await consumer.transactionsOf(wallet)).toHaveLength(1);
  });

  test("mesmo messageId com conteúdo diferente (P9) vai para a DLQ e não produz efeito", async () => {
    const wallet = await consumer.wallet("100.00");
    const messageId = `msg-${randomUUID()}`;
    const original = consumer.payload(wallet, { money: money("30.00") });
    await consumer.send(original, { messageId });
    consumer.start();
    await consumer.settled();
    const before = await consumer.counts();

    await consumer.send(
      original,
      { messageId, data: { money: money("90.00") } },
      { deduplicationId: randomUUID() },
    );
    await consumer.settled();

    const deadLetters = await consumer.queues.drainDlq(1);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.failureReason).toBe("INBOX_PAYLOAD_MISMATCH");
    expect(await consumer.counts()).toEqual(before);
    expect(await consumer.balance(wallet)).toBe("70.00");
  });

  test("mesmo messageId com a mesma carga mas outra idempotencyKey também é conteúdo diferente (P9)", async () => {
    const wallet = await consumer.wallet("100.00");
    const messageId = `msg-${randomUUID()}`;
    const original = consumer.payload(wallet, { money: money("30.00") });
    await consumer.send(original, { messageId });
    consumer.start();
    await consumer.settled();
    const before = await consumer.counts();

    await consumer.send(
      original,
      { messageId, idempotencyKey: `outra-${randomUUID()}` },
      { deduplicationId: randomUUID() },
    );
    await consumer.settled();

    const deadLetters = await consumer.queues.drainDlq(1);
    expect(deadLetters.map((entry) => entry.failureReason)).toEqual(["INBOX_PAYLOAD_MISMATCH"]);
    expect(await consumer.counts()).toEqual(before);
  });
});

describe("consumidor SQS: ack somente depois do commit", () => {
  test("morte entre o commit e o ack: o efeito fica, a mensagem não é apagada, volta e é confirmada sem reaplicar", async () => {
    const wallet = await consumer.wallet("100.00");
    const message = await consumer.send(consumer.payload(wallet, { money: money("30.00") }));
    consumer.faults.armCrash("consumer.after_commit_before_ack");

    consumer.start();
    await waitUntil(
      () => consumer.faults.reached.includes("consumer.after_commit_before_ack"),
      "o handler chegar ao ponto entre commit e ack",
    );

    expect(await consumer.balance(wallet)).toBe("70.00");
    expect(await consumer.inboxCount(message.messageId)).toBe(1);
    expect(consumer.queue.deleted).toHaveLength(0);
    expect(await consumer.queues.inputDepth()).toBe(1);

    await consumer.settled();

    expect(consumer.queue.received.map((entry) => entry.receiveCount)).toEqual([1, 2]);
    expect(consumer.queue.deleted).toHaveLength(1);
    expect(await consumer.balance(wallet)).toBe("70.00");
    expect(await consumer.movements(wallet)).toHaveLength(1);
    expect(await consumer.transactionsOf(wallet)).toHaveLength(1);
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });

  const points = [
    "inbox.tryReceive:1",
    "transactions.add:1",
    "ledger.append:1",
    "wallets.save:1",
    "outbox.add:2",
    "inbox.markProcessed:1",
  ];

  for (const point of points) {
    test(`falha depois de ${point}, antes do commit: nada persiste (negócio e inbox), a mensagem volta e funciona`, async () => {
      const wallet = await consumer.wallet("100.00");
      const message = await consumer.send(consumer.payload(wallet, { money: money("30.00") }));
      const baseline = await consumer.counts();
      afterFailure.length = 0;
      plan.failAt = point;

      consumer.start();
      await consumer.settled();

      expect(plan.failAt).toBeUndefined();
      expect(afterFailure).toEqual([baseline]);
      expect(consumer.queue.received.map((entry) => entry.receiveCount)).toEqual([1, 2]);
      expect(consumer.queue.deleted).toHaveLength(1);
      expect(await consumer.balance(wallet)).toBe("70.00");
      expect(await consumer.movements(wallet)).toHaveLength(1);
      expect(await consumer.inboxCount(message.messageId)).toBe(1);
      expect(await consumer.queues.dlqDepth()).toBe(0);
    });
  }
});

describe("consumidor SQS: reversão antes da referência", () => {
  test("REFUND chega primeiro (PENDING_REFERENCE), a BET chega depois e o worker de pendências resolve", async () => {
    const wallet = await consumer.wallet("100.00");
    const bet = consumer.payload(wallet, { money: money("30.00") });
    await consumer.send(
      consumer.payload(wallet, {
        kind: "REFUND",
        money: money("30.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    await consumer.send(bet);

    consumer.start();
    await consumer.settled();

    const pending = (await consumer.transactionsOf(wallet)).find((t) => t.kind === "REFUND");
    expect(pending?.status).toBe("PENDING_REFERENCE");
    expect(await consumer.balance(wallet)).toBe("70.00");

    const report = await workerOf(consumer.api).tick(new Date(Date.now() + 60_000));

    expect(report.processed).toBe(1);
    expect((await consumer.transactionsOf(wallet)).map((t) => [t.kind, t.status])).toEqual([
      ["REFUND", "PROCESSED"],
      ["BET", "PROCESSED"],
    ]);
    expect(await consumer.balance(wallet)).toBe("100.00");
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });
});
