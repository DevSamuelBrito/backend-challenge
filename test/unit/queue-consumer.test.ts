import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Logger } from "@nestjs/common";
import type {
  MessageQueue,
  QueueMessage,
  ReceiveOptions,
} from "../../src/modules/messaging/application/message-queue.port";
import {
  type Disposition,
  type MessageHandler,
  QueueConsumer,
  type QueueConsumerSettings,
} from "../../src/modules/messaging/application/queue-consumer";
import type { FaultInjector, FaultPoint } from "../../src/shared/application/fault-injector.port";
import { createGate, waitUntil } from "../support/async";

const message = (id: string, overrides: Partial<QueueMessage> = {}): QueueMessage => ({
  sqsMessageId: id,
  receiptHandle: `handle-${id}`,
  body: id,
  groupId: id,
  deduplicationId: id,
  receiveCount: 1,
  ...overrides,
});

class FakeQueue implements MessageQueue {
  readonly batches: QueueMessage[][] = [];
  readonly events: string[] = [];
  readonly receives: ReceiveOptions[] = [];
  readonly receiveTimes: number[] = [];
  failReceive = 0;
  failDelete = false;
  failDeadLetter = false;

  async receive(options: ReceiveOptions): Promise<QueueMessage[]> {
    this.receives.push(options);
    this.receiveTimes.push(Date.now());

    if (this.failReceive > 0) {
      this.failReceive -= 1;
      throw new Error("SQS fora");
    }

    const next = this.batches.shift();

    if (next) {
      return next;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));

    return [];
  }

  async delete(target: QueueMessage): Promise<void> {
    this.events.push(`delete:${target.sqsMessageId}`);

    if (this.failDelete) {
      throw new Error("delete falhou");
    }
  }

  async changeVisibility(target: QueueMessage, seconds: number): Promise<void> {
    this.events.push(`visibility:${target.sqsMessageId}:${seconds}`);
  }

  async sendToDeadLetter(target: QueueMessage, reason: string): Promise<void> {
    this.events.push(`dlq:${target.sqsMessageId}:${reason}`);

    if (this.failDeadLetter) {
      throw new Error("dlq falhou");
    }
  }

  async deadLetterDepth(): Promise<number> {
    return 0;
  }
}

const settings = (overrides: Partial<QueueConsumerSettings> = {}): QueueConsumerSettings => ({
  waitSeconds: 1,
  batchSize: 10,
  concurrency: 4,
  visibilityTimeoutSeconds: 30,
  backoff: { baseSeconds: 1, maxSeconds: 60 },
  shutdownTimeoutMs: 2000,
  pollFailurePauseMs: 5,
  ...overrides,
});

function handlerOf(
  decide: (target: QueueMessage) => Disposition | Promise<Disposition>,
  log: string[] = [],
): MessageHandler {
  return {
    handle: async (target) => {
      log.push(`start:${target.sqsMessageId}`);
      const disposition = await decide(target);
      log.push(`end:${target.sqsMessageId}`);

      return disposition;
    },
  };
}

const noFaults: FaultInjector = { check: () => undefined };

interface LoggerSpy {
  mock: { calls: unknown[][] };
  mockRestore(): void;
}

describe("QueueConsumer", () => {
  let queue: FakeQueue;
  let consumers: QueueConsumer[];
  let warn: LoggerSpy;
  let error: LoggerSpy;

  beforeEach(() => {
    queue = new FakeQueue();
    consumers = [];
    warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await Promise.all(consumers.map((consumer) => consumer.stop()));
    warn.mockRestore();
    error.mockRestore();
  });

  function build(
    handler: MessageHandler,
    options: { faults?: FaultInjector; settings?: Partial<QueueConsumerSettings> } = {},
  ) {
    const consumer = new QueueConsumer(
      queue,
      handler,
      options.faults ?? noFaults,
      settings(options.settings),
    );
    consumers.push(consumer);

    return consumer;
  }

  const eventsStarting = (prefix: string) => queue.events.filter((e) => e.startsWith(prefix));

  test("ack: dispara o ponto de falha antes do delete e só então apaga a mensagem", async () => {
    const order: string[] = [];
    const faults: FaultInjector = {
      check: (point: FaultPoint) => {
        order.push(`fault:${point}`);
      },
    };
    queue.batches.push([message("a")]);
    const consumer = build(
      handlerOf(() => ({ kind: "ack" })),
      { faults },
    );

    consumer.start();
    await waitUntil(() => eventsStarting("delete:").length === 1, "o delete");

    expect(order).toEqual(["fault:consumer.after_commit_before_ack"]);
    expect(queue.events).toEqual(["delete:a"]);
  });

  test("morte entre o commit e o ack: não apaga nem altera a visibilidade", async () => {
    const faults: FaultInjector = {
      check: () => {
        throw new Error("morreu");
      },
    };
    queue.batches.push([message("a")]);
    const consumer = build(
      handlerOf(() => ({ kind: "ack" })),
      { faults },
    );

    consumer.start();
    await waitUntil(() => queue.receives.length >= 2, "o consumidor continuar");

    expect(queue.events).toEqual([]);
  });

  test("falha no delete depois do commit: a mensagem não é dada como concluída e volta sozinha", async () => {
    queue.failDelete = true;
    queue.batches.push([message("a", { groupId: "g" }), message("b", { groupId: "g" })]);
    const consumer = build(handlerOf(() => ({ kind: "ack" })));

    consumer.start();
    await waitUntil(() => eventsStarting("visibility:").length === 1, "a devolução do restante");

    expect(queue.events).toEqual(["delete:a", "visibility:b:0"]);
  });

  test("dead-letter: envia à DLQ e só depois apaga da entrada", async () => {
    queue.batches.push([message("a")]);
    const consumer = build(
      handlerOf(() => ({ kind: "dead-letter", reason: "MALFORMED_MESSAGE", detail: "x" })),
    );

    consumer.start();
    await waitUntil(() => eventsStarting("delete:").length === 1, "o delete");

    expect(queue.events).toEqual(["dlq:a:MALFORMED_MESSAGE", "delete:a"]);
  });

  test("dead-letter: se o envio à DLQ falhar, NÃO apaga a mensagem", async () => {
    queue.failDeadLetter = true;
    queue.batches.push([message("a")]);
    const consumer = build(
      handlerOf(() => ({ kind: "dead-letter", reason: "MALFORMED_MESSAGE", detail: "x" })),
    );

    consumer.start();
    await waitUntil(() => eventsStarting("dlq:").length === 1, "a tentativa de envio à DLQ");
    await waitUntil(() => queue.receives.length >= 2, "o consumidor continuar");

    expect(eventsStarting("delete:")).toEqual([]);
  });

  test("dead-letter registra um warn estruturado com o motivo", async () => {
    queue.batches.push([message("a", { groupId: "wallet-1", receiveCount: 3 })]);
    const consumer = build(
      handlerOf(() => ({ kind: "dead-letter", reason: "WALLET_NOT_FOUND", detail: "sem wallet" })),
    );

    consumer.start();
    await waitUntil(() => eventsStarting("delete:").length === 1, "o delete");

    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      event: "consumer.dead_letter",
      reason: "WALLET_NOT_FOUND",
      detail: "sem wallet",
      sqsMessageId: "a",
      groupId: "wallet-1",
      receiveCount: 3,
    });
  });

  test("retry: muda a visibilidade com backoff exponencial pelo ApproximateReceiveCount, com teto", async () => {
    queue.batches.push(
      [1, 2, 3, 4, 5, 7, 12].map((count) => message(`m${count}`, { receiveCount: count })),
    );
    const consumer = build(
      handlerOf(() => ({ kind: "retry", reason: "LOCK_TIMEOUT", detail: "" })),
      {
        settings: { concurrency: 7 },
      },
    );

    consumer.start();
    await waitUntil(() => eventsStarting("visibility:").length === 7, "as 7 devoluções");

    expect([...eventsStarting("visibility:")].sort()).toEqual(
      [
        "visibility:m1:1",
        "visibility:m2:2",
        "visibility:m3:4",
        "visibility:m4:8",
        "visibility:m5:16",
        "visibility:m7:60",
        "visibility:m12:60",
      ].sort(),
    );
    expect(eventsStarting("delete:")).toEqual([]);
  });

  test("retry respeita a base e o teto configurados", async () => {
    queue.batches.push([message("a", { receiveCount: 3 })]);
    const consumer = build(
      handlerOf(() => ({ kind: "retry", reason: "X", detail: "" })),
      {
        settings: { backoff: { baseSeconds: 3, maxSeconds: 10 } },
      },
    );

    consumer.start();
    await waitUntil(() => eventsStarting("visibility:").length === 1, "a devolução");

    expect(queue.events).toEqual(["visibility:a:10"]);
  });

  test("handler que lança é tratado como transitório: nunca apaga", async () => {
    queue.batches.push([message("a", { receiveCount: 2 })]);
    const consumer = build({
      handle: async () => {
        throw new Error("explodiu");
      },
    });

    consumer.start();
    await waitUntil(() => eventsStarting("visibility:").length === 1, "a devolução");

    expect(queue.events).toEqual(["visibility:a:2"]);
  });

  test("mensagens do mesmo grupo são processadas em ordem e nunca em paralelo; grupos diferentes, em paralelo", async () => {
    const log: string[] = [];
    const gate = createGate();
    queue.batches.push([
      message("a1", { groupId: "A" }),
      message("b1", { groupId: "B" }),
      message("a2", { groupId: "A" }),
    ]);
    const consumer = build(
      handlerOf(async (target) => {
        if (target.sqsMessageId === "a1") {
          await gate.opened;
        }

        return { kind: "ack" };
      }, log),
    );

    consumer.start();
    await waitUntil(() => log.includes("end:b1"), "o grupo B terminar enquanto A está preso");

    expect(log).toEqual(["start:a1", "start:b1", "end:b1"]);

    gate.open();
    await waitUntil(() => log.includes("end:a2"), "o grupo A terminar");

    expect(log.indexOf("start:a2")).toBeGreaterThan(log.indexOf("end:a1"));
  });

  test("a concorrência limita quantos grupos rodam ao mesmo tempo", async () => {
    let running = 0;
    let peak = 0;
    queue.batches.push(Array.from({ length: 8 }, (_, index) => message(`m${index}`)));
    const consumer = build(
      handlerOf(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;

        return { kind: "ack" };
      }),
      { settings: { concurrency: 3 } },
    );

    consumer.start();
    await waitUntil(() => eventsStarting("delete:").length === 8, "as 8 mensagens");

    expect(peak).toBe(3);
  });

  test("falha numa mensagem devolve imediatamente o resto do grupo no lote, sem processá-lo", async () => {
    const log: string[] = [];
    queue.batches.push([
      message("a1", { groupId: "A" }),
      message("a2", { groupId: "A" }),
      message("a3", { groupId: "A" }),
      message("b1", { groupId: "B" }),
    ]);
    const consumer = build(
      handlerOf(
        (target) =>
          target.sqsMessageId === "a1"
            ? { kind: "retry", reason: "LOCK_TIMEOUT", detail: "" }
            : { kind: "ack" },
        log,
      ),
    );

    consumer.start();
    await waitUntil(() => eventsStarting("visibility:").length === 3, "as devoluções");

    expect(log).not.toContain("start:a2");
    expect(log).not.toContain("start:a3");
    expect([...eventsStarting("visibility:")].sort()).toEqual([
      "visibility:a1:1",
      "visibility:a2:0",
      "visibility:a3:0",
    ]);
    expect(queue.events).toContain("delete:b1");
  });

  test("falha ao buscar mensagens: espera a pausa configurada antes de tentar de novo", async () => {
    queue.failReceive = 1;
    const consumer = build(
      handlerOf(() => ({ kind: "ack" })),
      {
        settings: { pollFailurePauseMs: 150 },
      },
    );

    consumer.start();
    await waitUntil(() => queue.receives.length >= 2, "a segunda busca");

    const [first, second] = queue.receiveTimes as [number, number];
    expect(second - first).toBeGreaterThanOrEqual(120);
  });

  test("falha ao buscar mensagens: registra, faz uma pausa e continua", async () => {
    queue.failReceive = 2;
    queue.batches.push([message("a")]);
    const consumer = build(handlerOf(() => ({ kind: "ack" })));

    consumer.start();
    await waitUntil(() => eventsStarting("delete:").length === 1, "o consumo depois da falha");

    expect(error.mock.calls).toHaveLength(2);
  });

  test("os parâmetros de recebimento vêm da configuração", async () => {
    const consumer = build(
      handlerOf(() => ({ kind: "ack" })),
      {
        settings: { waitSeconds: 7, batchSize: 4, visibilityTimeoutSeconds: 9 },
      },
    );

    consumer.start();
    await waitUntil(() => queue.receives.length >= 1, "o primeiro recebimento");

    expect(queue.receives[0]).toEqual({
      maxMessages: 4,
      waitSeconds: 7,
      visibilityTimeoutSeconds: 9,
    });
  });

  test("start repetido não cria um segundo laço", async () => {
    const consumer = build(handlerOf(() => ({ kind: "ack" })));

    consumer.start();
    consumer.start();
    await waitUntil(() => queue.receives.length >= 3, "alguns recebimentos");
    await consumer.stop();
    const total = queue.receives.length;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(queue.receives.length).toBe(total);
  });

  describe("encerramento", () => {
    test("espera a mensagem em andamento e devolve na hora as que não começaram", async () => {
      const gate = createGate();
      const started = createGate();
      queue.batches.push([message("a"), message("b"), message("c")]);
      const consumer = build(
        handlerOf(async (target) => {
          if (target.sqsMessageId === "a") {
            started.open();
            await gate.opened;
          }

          return { kind: "ack" };
        }),
        { settings: { concurrency: 1 } },
      );

      consumer.start();
      await started.opened;

      let stopped = false;
      const stopping = consumer.stop().then(() => {
        stopped = true;
      });
      await waitUntil(() => eventsStarting("visibility:").length === 2, "a devolução imediata");
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(stopped).toBe(false);
      expect([...eventsStarting("visibility:")].sort()).toEqual([
        "visibility:b:0",
        "visibility:c:0",
      ]);

      gate.open();
      await stopping;

      expect(stopped).toBe(true);
      expect(queue.events).toContain("delete:a");
      expect(eventsStarting("delete:")).toEqual(["delete:a"]);
    });

    test("a espera por mensagens em andamento tem um limite de tempo", async () => {
      const started = createGate();
      queue.batches.push([message("a")]);
      const consumer = build(
        handlerOf(async () => {
          started.open();
          await new Promise(() => undefined);

          return { kind: "ack" };
        }),
        { settings: { shutdownTimeoutMs: 80 } },
      );

      consumer.start();
      await started.opened;
      const startedAt = Date.now();
      await consumer.stop();

      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("Encerramento excedeu"))).toBe(
        true,
      );
    });

    test("um lote que chega depois do encerramento é devolvido sem ser processado", async () => {
      const handled: string[] = [];
      const release = createGate();
      const consumer = build(
        handlerOf((target) => {
          handled.push(target.sqsMessageId);

          return { kind: "ack" };
        }),
      );
      const original = queue.receive.bind(queue);
      let pending = 0;
      queue.receive = async (options) => {
        pending += 1;
        await release.opened;

        return original(options);
      };
      queue.batches.push([message("a"), message("b")]);

      consumer.start();
      await waitUntil(() => pending === 1, "o recebimento pendente");
      const stopping = consumer.stop();
      release.open();
      await stopping;

      expect(handled).toEqual([]);
      expect([...eventsStarting("visibility:")].sort()).toEqual([
        "visibility:a:0",
        "visibility:b:0",
      ]);
    });

    test("parar um consumidor que nunca iniciou não faz nada", async () => {
      const consumer = build(handlerOf(() => ({ kind: "ack" })));

      await consumer.stop();

      expect(queue.receives).toHaveLength(0);
    });
  });
});
