import { describe, expect, spyOn, test } from "bun:test";
import { Logger } from "@nestjs/common";
import type {
  EventPublisher,
  OutboundEvent,
  PublishOutcome,
} from "../../src/modules/messaging/application/event-publisher.port";
import type { OutboxRepository } from "../../src/modules/messaging/application/outbox.repository";
import { OutboxPublisher } from "../../src/modules/messaging/application/outbox-publisher";
import { OutboxMessage } from "../../src/modules/messaging/domain/outbox-message";
import type { FaultInjector } from "../../src/shared/application/fault-injector.port";
import type { UnitOfWork } from "../../src/shared/application/unit-of-work.port";

const NOW = new Date("2031-05-05T10:00:00.000Z");

function message(id: string, overrides: { attempts?: number; walletId?: string | null } = {}) {
  const walletId = overrides.walletId === undefined ? `wallet-${id}` : overrides.walletId;

  return OutboxMessage.rehydrate({
    id,
    aggregateId: "00000000-0000-7000-8000-000000000001",
    eventType: "WalletBalanceChanged",
    payload: { eventId: id, data: walletId === null ? {} : { walletId } },
    occurredAt: NOW,
    attempts: overrides.attempts ?? 0,
    nextAttemptAt: NOW,
  });
}

function build(options: {
  batch: OutboxMessage[];
  publisher?: EventPublisher;
  faults?: FaultInjector;
  alertAttempts?: number;
}) {
  const calls: string[] = [];
  const saved: OutboxMessage[] = [];
  const outbox: OutboxRepository = {
    add: async () => undefined,
    oldestPendingAt: async () => undefined,
    lockDueBatch: async () => {
      calls.push("lock");
      return options.batch;
    },
    save: async (saved1) => {
      calls.push(`save:${saved1.id}`);
      saved.push(saved1);
    },
  };
  const unitOfWork = {
    run: async (work: (repositories: { outbox: OutboxRepository }) => Promise<unknown>) =>
      work({ outbox }),
  } as unknown as UnitOfWork;
  const publisher: EventPublisher = options.publisher ?? {
    publish: async (events) => events.map((event) => ({ eventId: event.eventId, confirmed: true })),
  };
  const faults: FaultInjector = options.faults ?? { check: () => undefined };

  return {
    calls,
    saved,
    service: new OutboxPublisher(unitOfWork, publisher, faults, {
      batchSize: 10,
      alertAttempts: options.alertAttempts ?? 10,
    }),
  };
}

describe("OutboxPublisher.tick", () => {
  test("lote vazio: não chama o publisher nem salva nada", async () => {
    let sends = 0;
    const { service, saved } = build({
      batch: [],
      publisher: {
        publish: async () => {
          sends += 1;
          return [];
        },
      },
    });

    expect(await service.tick(NOW)).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(sends).toBe(0);
    expect(saved).toHaveLength(0);
  });

  test("o corpo enviado é o envelope serializado, e o group id é data.walletId", async () => {
    const seen: OutboundEvent[] = [];
    const { service } = build({
      batch: [message("a")],
      publisher: {
        publish: async (events) => {
          seen.push(...events);
          return events.map((event) => ({ eventId: event.eventId, confirmed: true }));
        },
      },
    });

    await service.tick(NOW);

    expect(seen).toEqual([
      {
        eventId: "a",
        eventType: "WalletBalanceChanged",
        groupId: "wallet-a",
        body: JSON.stringify({ eventId: "a", data: { walletId: "wallet-a" } }),
      },
    ]);
  });

  test("confirmadas ficam published_at = agora; não confirmadas ganham tentativa e backoff; tudo é salvo", async () => {
    const { service, saved } = build({
      batch: [message("a"), message("b"), message("c")],
      publisher: {
        publish: async (events): Promise<PublishOutcome[]> =>
          events.map((event) =>
            event.eventId === "b"
              ? { eventId: "b", confirmed: false, reason: "falhou" }
              : { eventId: event.eventId, confirmed: true },
          ),
      },
    });

    const report = await service.tick(NOW);

    expect(report).toEqual({ claimed: 3, published: 2, failed: 1 });
    expect(saved.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(saved[0]?.publishedAt).toEqual(NOW);
    expect(saved[2]?.publishedAt).toEqual(NOW);
    expect(saved[1]?.publishedAt).toBeUndefined();
    expect(saved[1]?.attempts).toBe(1);
    expect(saved[1]?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 1000));
  });

  test("o publisher lançar uma exceção não perde nada: todas ganham tentativa e o tick não falha", async () => {
    const { service, saved } = build({
      batch: [message("a"), message("b")],
      publisher: {
        publish: async () => {
          throw new Error("SDK explodiu");
        },
      },
    });

    const report = await service.tick(NOW);

    expect(report).toEqual({ claimed: 2, published: 0, failed: 2 });
    expect(saved.map((item) => item.attempts)).toEqual([1, 1]);
    expect(saved.every((item) => item.publishedAt === undefined)).toBe(true);
  });

  test("resposta sem uma das entradas: a ausente nunca é dada como publicada", async () => {
    const { service, saved } = build({
      batch: [message("a"), message("b")],
      publisher: { publish: async () => [{ eventId: "a", confirmed: true }] },
    });

    const report = await service.tick(NOW);

    expect(report).toEqual({ claimed: 2, published: 1, failed: 1 });
    expect(saved[1]?.attempts).toBe(1);
  });

  test("evento sem walletId não é enviado e ganha tentativa; os demais seguem", async () => {
    const sentIds: string[] = [];
    const { service, saved } = build({
      batch: [message("a"), message("b", { walletId: null }), message("c")],
      publisher: {
        publish: async (events) => {
          sentIds.push(...events.map((event) => event.eventId));
          return events.map((event) => ({ eventId: event.eventId, confirmed: true }));
        },
      },
    });

    const report = await service.tick(NOW);

    expect(sentIds).toEqual(["a", "c"]);
    expect(report).toEqual({ claimed: 3, published: 2, failed: 1 });
    expect(saved[1]?.attempts).toBe(1);
  });

  test("todos sem walletId: o publisher nem é chamado", async () => {
    let sends = 0;
    const { service } = build({
      batch: [message("a", { walletId: null })],
      publisher: {
        publish: async () => {
          sends += 1;
          return [];
        },
      },
    });

    expect(await service.tick(NOW)).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(sends).toBe(0);
  });

  test("o ponto de falha outbox.after_send_before_mark roda DEPOIS do envio e ANTES de qualquer marcação", async () => {
    const order: string[] = [];
    const crash = new Error("morreu");
    const { service, calls } = build({
      batch: [message("a")],
      publisher: {
        publish: async (events) => {
          order.push("send");
          return events.map((event) => ({ eventId: event.eventId, confirmed: true }));
        },
      },
      faults: {
        check: (point) => {
          order.push(`fault:${point}`);
          throw crash;
        },
      },
    });

    await expect(service.tick(NOW)).rejects.toBe(crash);

    expect(order).toEqual(["send", "fault:outbox.after_send_before_mark"]);
    expect(calls).toEqual(["lock"]);
  });

  test("aviso (warn) só quando attempts passa do limiar configurável", async () => {
    const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const failing: EventPublisher = {
        publish: async (events) =>
          events.map((event) => ({ eventId: event.eventId, confirmed: false, reason: "SQS fora" })),
      };
      const { service } = build({
        batch: [
          message("abaixo", { attempts: 2 }),
          message("no-limite", { attempts: 4 }),
          message("acima", { attempts: 5 }),
        ],
        publisher: failing,
        alertAttempts: 5,
      });

      await service.tick(NOW);

      const logged = warn.mock.calls.map((call) => call[0] as Record<string, unknown>);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        event: "outbox.publish_late",
        eventId: "acima",
        attempts: 6,
        reason: "SQS fora",
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("a mensagem nunca é descartada, por mais tentativas que acumule", async () => {
    const { service, saved } = build({
      batch: [message("a", { attempts: 10_000 })],
      publisher: { publish: async () => [{ eventId: "a", confirmed: false, reason: "x" }] },
    });

    await service.tick(NOW);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.attempts).toBe(10_001);
    expect(saved[0]?.isPending()).toBe(true);
    expect(saved[0]?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 60_000));
  });
});
