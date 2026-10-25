import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Client } from "pg";
import { waitUntil } from "../support/async";
import { useConsumer } from "../support/consumer-scenario";
import { setDatabaseAvailable } from "../support/database";
import type { OpenedWallet } from "../support/wagering-api";

setDefaultTimeout(40_000);

const money = (amount: string) => ({ amount, currency: "BRL" });

const consumer = useConsumer({}, { lockTimeoutMs: 300 });

let holder: Client | undefined;

afterEach(async () => {
  if (holder) {
    await holder.query("rollback").catch(() => undefined);
    await holder.end().catch(() => undefined);
    holder = undefined;
  }

  await setDatabaseAvailable(consumer.api.db, true);
});

async function holdWalletLock(wallet: OpenedWallet): Promise<void> {
  holder = await consumer.api.db.connect();
  await holder.query("begin");
  await holder.query("select id from wallets where id = $1 for update", [wallet.id]);
}

async function releaseWalletLock(): Promise<void> {
  await holder?.query("rollback");
}

describe("consumidor SQS: erros permanentes vão para a DLQ", () => {
  const permanentCases: [string, string, (wallet: OpenedWallet) => unknown][] = [
    ["JSON malformado", "MALFORMED_MESSAGE", () => "{isto não é json"],
    ["corpo que não é um objeto", "MALFORMED_MESSAGE", () => "[1, 2, 3]"],
    [
      "type diferente de WagerTransactionRequested",
      "UNEXPECTED_MESSAGE_TYPE",
      (wallet) => consumer.message(consumer.payload(wallet), { type: "OutraCoisa" }),
    ],
    [
      "type ausente",
      "UNEXPECTED_MESSAGE_TYPE",
      (wallet) => ({
        ...consumer.message(consumer.payload(wallet)),
        type: undefined,
      }),
    ],
    [
      "valor com mais de 2 casas",
      "INVALID_PAYLOAD",
      (wallet) =>
        consumer.message(
          consumer.payload(wallet, { money: { amount: "10.555", currency: "BRL" } }),
        ),
    ],
    [
      "valor zero",
      "INVALID_PAYLOAD",
      (wallet) => consumer.message(consumer.payload(wallet, { money: money("0.00") })),
    ],
    [
      "campo obrigatório ausente",
      "INVALID_PAYLOAD",
      (wallet) => consumer.message(consumer.payload(wallet), { data: { providerId: undefined } }),
    ],
    [
      "idempotencyKey ausente",
      "INVALID_PAYLOAD",
      (wallet) =>
        consumer.message(consumer.payload(wallet), { data: { idempotencyKey: undefined } }),
    ],
    [
      "messageId ausente",
      "INVALID_PAYLOAD",
      (wallet) => ({ ...consumer.message(consumer.payload(wallet)), messageId: undefined }),
    ],
    [
      "data ausente",
      "INVALID_PAYLOAD",
      (wallet) => ({ ...consumer.message(consumer.payload(wallet)), data: undefined }),
    ],
    [
      "kind OPENING",
      "INVALID_PAYLOAD",
      (wallet) => consumer.message(consumer.payload(wallet, { kind: "OPENING" })),
    ],
    [
      "kind desconhecido",
      "INVALID_PAYLOAD",
      (wallet) => consumer.message(consumer.payload(wallet, { kind: "TIP" })),
    ],
    [
      "reversão sem referência",
      "INVALID_PAYLOAD",
      (wallet) => consumer.message(consumer.payload(wallet, { kind: "REFUND" })),
    ],
    [
      "wallet inexistente",
      "WALLET_NOT_FOUND",
      (wallet) => consumer.message(consumer.payload(wallet, { walletId: randomUUID() })),
    ],
  ];

  for (const [name, reason, build] of permanentCases) {
    test(`${name}: DLQ (${reason}), sai da entrada, sem efeito e sem registro no inbox`, async () => {
      const wallet = await consumer.wallet("100.00");
      const message = build(wallet);
      const baseline = await consumer.counts();
      const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

      try {
        await consumer.queues.send(message, { groupId: wallet.id, deduplicationId: randomUUID() });
        consumer.start();
        await consumer.settled();

        const deadLetters = await consumer.queues.drainDlq(1);
        expect(deadLetters).toHaveLength(1);
        expect(deadLetters[0]?.failureReason).toBe(reason);
        expect(deadLetters[0]?.body).toBe(
          typeof message === "string" ? message : JSON.stringify(message),
        );
        expect(deadLetters[0]?.groupId).toBe(wallet.id);
        expect(await consumer.counts()).toEqual(baseline);
        expect(await consumer.balance(wallet)).toBe("100.00");
        expect(consumer.queue.deleted).toHaveLength(1);

        const logged = warn.mock.calls
          .map((call) => call[0] as { event?: string; reason?: string })
          .filter((entry) => entry?.event === "consumer.dead_letter");
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ reason, receiveCount: 1 });
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("conflito de idempotência (mesma chave, conteúdo diferente): DLQ, e a transação original não muda", async () => {
    const wallet = await consumer.wallet("100.00");
    const original = consumer.payload(wallet, { money: money("30.00") });
    await consumer.send(original);
    consumer.start();
    await consumer.settled();
    const baseline = await consumer.counts();

    await consumer.send(original, { data: { money: money("45.00") } });
    await consumer.settled();

    const deadLetters = await consumer.queues.drainDlq(1);
    expect(deadLetters.map((entry) => entry.failureReason)).toEqual(["IDEMPOTENCY_CONFLICT"]);
    expect(await consumer.counts()).toEqual(baseline);
    expect(await consumer.balance(wallet)).toBe("70.00");
  });

  test("conflito de transação externa (outra chave, mesmo provedor e id externo): DLQ", async () => {
    const wallet = await consumer.wallet("100.00");
    const original = consumer.payload(wallet, { money: money("30.00") });
    await consumer.send(original);
    consumer.start();
    await consumer.settled();
    const baseline = await consumer.counts();

    await consumer.send(original, { idempotencyKey: `outra-chave-${randomUUID()}` });
    await consumer.settled();

    const deadLetters = await consumer.queues.drainDlq(1);
    expect(deadLetters.map((entry) => entry.failureReason)).toEqual([
      "EXTERNAL_TRANSACTION_CONFLICT",
    ]);
    expect(await consumer.counts()).toEqual(baseline);
    expect(await consumer.balance(wallet)).toBe("70.00");
  });

  test("a DLQ recebe antes do delete: a ordem é envio para a DLQ e só então a remoção da entrada", async () => {
    const wallet = await consumer.wallet("100.00");
    await consumer.queues.send("{quebrado", { groupId: wallet.id, deduplicationId: randomUUID() });

    consumer.start();
    await consumer.settled();

    const [first, second] = consumer.queue.events;
    expect(first).toMatch(/^dlq:/);
    expect(second).toMatch(/^delete:/);
    expect(consumer.queue.events).toHaveLength(2);
  });

  test("falha ao enviar para a DLQ: a mensagem NÃO é apagada da entrada e é tentada de novo", async () => {
    const wallet = await consumer.wallet("100.00");
    consumer.queue.failDeadLetter = true;
    await consumer.queues.send("{quebrado", { groupId: wallet.id, deduplicationId: randomUUID() });

    consumer.start();
    await waitUntil(
      () => consumer.queue.events.filter((event) => event.startsWith("dlq:")).length >= 2,
      "duas tentativas de envio à DLQ",
      20_000,
    );

    expect(consumer.queue.deleted).toHaveLength(0);
    expect(await consumer.queues.inputDepth()).toBe(1);
    expect(await consumer.queues.dlqDepth()).toBe(0);
    expect(consumer.queue.received.map((entry) => entry.receiveCount).slice(0, 2)).toEqual([1, 2]);

    consumer.queue.failDeadLetter = false;
    await consumer.settled();

    const deadLetters = await consumer.queues.drainDlq(1);
    expect(deadLetters).toHaveLength(1);
    expect(consumer.queue.deleted).toHaveLength(1);
    expect(await consumer.queues.inputDepth()).toBe(0);
  });
});

describe("consumidor SQS: erros transitórios não confirmam e voltam com backoff", () => {
  test("lock timeout: não confirma, a visibilidade cresce 1s, 2s, 4s e, liberado o lock, a mensagem é processada", async () => {
    const wallet = await consumer.wallet("100.00");
    const message = await consumer.send(consumer.payload(wallet, { money: money("30.00") }));
    await holdWalletLock(wallet);
    const baseline = await consumer.counts();

    consumer.start();
    await waitUntil(
      () => consumer.queue.visibilityChanges.length >= 3,
      "três tentativas bloqueadas pelo lock",
      30_000,
    );

    expect(consumer.queue.visibilityChanges.slice(0, 3).map((change) => change.seconds)).toEqual([
      1, 2, 4,
    ]);
    expect(consumer.queue.deleted).toHaveLength(0);
    expect(await consumer.counts()).toEqual(baseline);
    expect(await consumer.queues.dlqDepth()).toBe(0);

    await releaseWalletLock();
    await consumer.settled();

    expect(await consumer.balance(wallet)).toBe("70.00");
    expect(await consumer.inboxCount(message.messageId)).toBe(1);
    expect(consumer.queue.deleted).toHaveLength(1);
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });

  test("falha desconhecida (erro inesperado) é transitória: volta sem ir para a DLQ", async () => {
    const wallet = await consumer.wallet("100.00");
    await consumer.send(consumer.payload(wallet, { money: money("30.00") }));
    await holdWalletLock(wallet);

    consumer.start();
    await waitUntil(() => consumer.queue.visibilityChanges.length >= 1, "uma tentativa falhar");
    await releaseWalletLock();
    await consumer.settled();

    expect(await consumer.queues.dlqDepth()).toBe(0);
    expect(await consumer.balance(wallet)).toBe("70.00");
  });

  test("banco indisponível: não confirma, tenta de novo e, quando volta, processa uma única vez", async () => {
    const wallet = await consumer.wallet("100.00");
    const message = await consumer.send(consumer.payload(wallet, { money: money("30.00") }));
    await setDatabaseAvailable(consumer.api.db, false);

    consumer.start();
    await waitUntil(
      () => consumer.queue.visibilityChanges.length >= 2,
      "duas tentativas com o banco fora",
      30_000,
    );

    expect(consumer.queue.deleted).toHaveLength(0);
    expect(await consumer.queues.dlqDepth()).toBe(0);
    expect(await consumer.balance(wallet)).toBe("100.00");

    await setDatabaseAvailable(consumer.api.db, true);
    await consumer.settled(30_000);

    expect(await consumer.balance(wallet)).toBe("70.00");
    expect(await consumer.movements(wallet)).toHaveLength(1);
    expect(await consumer.inboxCount(message.messageId)).toBe(1);
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });
});
