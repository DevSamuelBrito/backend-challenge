import { describe, expect, test } from "bun:test";
import { OutboxMessageAlreadyPublishedError } from "../../src/modules/messaging/domain/messaging-errors";
import {
  OUTBOX_RETRY_BASE_DELAY_MS,
  OUTBOX_RETRY_MAX_DELAY_MS,
  OutboxMessage,
} from "../../src/modules/messaging/domain/outbox-message";
import { WagerTransactionProcessed } from "../../src/modules/wagering/domain/events/wager-transaction-processed";
import { WagerTransactionStatus } from "../../src/modules/wagering/domain/wager-transaction";
import { WalletBalanceChanged } from "../../src/modules/wallet/domain/events/wallet-balance-changed";
import { DomainError } from "../../src/shared/domain/domain-error";
import { containsMoneyInstance } from "../support/contains-money";
import { AT, aContext, aLedgerEntry, aTransaction, brl } from "../support/wagering-builders";

const event = () => WalletBalanceChanged.from(aLedgerEntry(), aContext());

const at = (offsetMs: number, base = AT) => new Date(base.getTime() + offsetMs);

function delaysForRetries(count: number, now: Date): number[] {
  const message = OutboxMessage.enqueue(event());
  const delays: number[] = [];

  for (let index = 0; index < count; index++) {
    message.scheduleRetry(now);
    delays.push((message.nextAttemptAt as Date).getTime() - now.getTime());
  }

  return delays;
}

describe("OutboxMessage.enqueue", () => {
  test("nasce pendente, sem tentativas e já devida, a partir do evento", () => {
    const message = OutboxMessage.enqueue(event());

    expect(message.id).toBe("evt-1");
    expect(message.aggregateId).toBe("wallet-1");
    expect(message.eventType).toBe("WalletBalanceChanged");
    expect(message.occurredAt).toBe(AT);
    expect(message.attempts).toBe(0);
    expect(message.publishedAt).toBeUndefined();
    expect(message.isPending()).toBe(true);
    expect(message.isDue(AT)).toBe(true);
  });

  test("o payload é o envelope serializado do evento, sem instâncias de Money", () => {
    const source = event();
    const message = OutboxMessage.enqueue(source);

    expect(message.payload).toEqual(JSON.parse(JSON.stringify(source)));
    expect(containsMoneyInstance(message.payload)).toBe(false);
    expect(message.payload.occurredAt).toBe("2026-01-01T12:00:00.000Z");
  });

  test("o payload é uma cópia: não compartilha objetos com o evento", () => {
    const source = event();
    const message = OutboxMessage.enqueue(source);

    expect(message.payload.data).not.toBe(source.data);
  });

  test("o id da mensagem é o eventId, então o mesmo evento nunca duplica a outbox", () => {
    const first = OutboxMessage.enqueue(event());
    const second = OutboxMessage.enqueue(event());

    expect(first.id).toBe(second.id);
  });

  test("funciona para eventos de transação, com aggregateId = transactionId", () => {
    const processed = WagerTransactionProcessed.from(
      aTransaction({
        status: WagerTransactionStatus.Processed,
        balanceAfter: brl("75.00"),
      }),
      aContext({ eventId: "evt-2" }),
    );

    const message = OutboxMessage.enqueue(processed);

    expect(message.id).toBe("evt-2");
    expect(message.aggregateId).toBe("tx-1");
    expect(message.eventType).toBe("WagerTransactionProcessed");
  });
});

describe("OutboxMessage.isDue", () => {
  test("antes, exatamente em e depois do nextAttemptAt", () => {
    const message = OutboxMessage.enqueue(event());
    message.scheduleRetry(AT);
    const due = message.nextAttemptAt as Date;

    expect(message.isDue(at(-1, due))).toBe(false);
    expect(message.isDue(at(-1000, due))).toBe(false);
    expect(message.isDue(due)).toBe(true);
    expect(message.isDue(at(1, due))).toBe(true);
    expect(message.isDue(at(3_600_000, due))).toBe(true);
  });

  test("mensagem publicada nunca está devida", () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(at(1000));

    expect(message.isDue(at(10_000_000))).toBe(false);
  });

  test("sem nextAttemptAt, uma mensagem pendente está devida", () => {
    const message = OutboxMessage.rehydrate({
      id: "evt-1",
      aggregateId: "wallet-1",
      eventType: "WalletBalanceChanged",
      payload: {},
      occurredAt: AT,
      attempts: 0,
    });

    expect(message.isDue(AT)).toBe(true);
  });

  test("o relógio é sempre o parâmetro, nunca o horário real da máquina", () => {
    const message = OutboxMessage.enqueue(event());
    message.scheduleRetry(AT);

    expect(message.isDue(new Date("1970-01-01T00:00:00.000Z"))).toBe(false);
    expect(message.isDue(new Date("2999-01-01T00:00:00.000Z"))).toBe(true);
  });
});

describe("OutboxMessage.markPublished", () => {
  test("marca como publicada e deixa de ser pendente", () => {
    const message = OutboxMessage.enqueue(event());
    const publishedAt = at(2500);

    message.markPublished(publishedAt);

    expect(message.publishedAt).toBe(publishedAt);
    expect(message.isPending()).toBe(false);
  });

  test("não zera as tentativas já feitas", () => {
    const message = OutboxMessage.enqueue(event());
    message.scheduleRetry(AT);
    message.scheduleRetry(AT);

    message.markPublished(at(9000));

    expect(message.attempts).toBe(2);
  });

  test("publicar de novo é transição inválida e mantém o instante original", () => {
    const message = OutboxMessage.enqueue(event());
    const publishedAt = at(1000);
    message.markPublished(publishedAt);

    expect(() => message.markPublished(at(5000))).toThrow(OutboxMessageAlreadyPublishedError);
    expect(message.publishedAt).toBe(publishedAt);
  });

  test("o erro é de domínio e tem código estável", () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(at(1000));

    try {
      message.markPublished(at(2000));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as OutboxMessageAlreadyPublishedError).code).toBe(
        "OUTBOX_MESSAGE_ALREADY_PUBLISHED",
      );
    }
  });
});

describe("OutboxMessage.scheduleRetry: backoff exponencial com teto", () => {
  test("incrementa attempts a cada chamada", () => {
    const message = OutboxMessage.enqueue(event());

    message.scheduleRetry(AT);
    expect(message.attempts).toBe(1);
    message.scheduleRetry(AT);
    expect(message.attempts).toBe(2);
    message.scheduleRetry(AT);
    expect(message.attempts).toBe(3);
  });

  test("os valores documentados: base de 1s e teto de 60s", () => {
    expect(OUTBOX_RETRY_BASE_DELAY_MS).toBe(1_000);
    expect(OUTBOX_RETRY_MAX_DELAY_MS).toBe(60_000);
  });

  test("a espera dobra a cada falha: 1s, 2s, 4s, 8s, 16s, 32s", () => {
    expect(delaysForRetries(6, AT)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000]);
  });

  test("a partir da sétima falha, a espera para no teto de 60s", () => {
    expect(delaysForRetries(10, AT)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000,
    ]);
  });

  test("nunca passa do teto, mesmo com milhares de tentativas", () => {
    const message = OutboxMessage.rehydrate({
      id: "evt-1",
      aggregateId: "wallet-1",
      eventType: "WalletBalanceChanged",
      payload: {},
      occurredAt: AT,
      attempts: 5_000,
    });

    message.scheduleRetry(AT);

    expect(message.attempts).toBe(5_001);
    expect((message.nextAttemptAt as Date).getTime() - AT.getTime()).toBe(60_000);
  });

  test("nunca encurta: cada espera é maior ou igual à anterior", () => {
    const delays = delaysForRetries(40, AT);

    for (let index = 1; index < delays.length; index++) {
      expect(delays[index] as number).toBeGreaterThanOrEqual(delays[index - 1] as number);
    }
    expect(Math.max(...delays)).toBe(OUTBOX_RETRY_MAX_DELAY_MS);
  });

  test("a próxima tentativa é calculada a partir do 'now' recebido", () => {
    const now = new Date("2030-06-15T10:00:00.000Z");
    const message = OutboxMessage.enqueue(event());

    message.scheduleRetry(now);

    expect(message.nextAttemptAt).toEqual(new Date("2030-06-15T10:00:01.000Z"));
  });

  test("uma mensagem reidratada continua o backoff de onde parou", () => {
    const message = OutboxMessage.rehydrate({
      id: "evt-1",
      aggregateId: "wallet-1",
      eventType: "WalletBalanceChanged",
      payload: {},
      occurredAt: AT,
      attempts: 3,
      nextAttemptAt: AT,
    });

    message.scheduleRetry(AT);

    expect(message.attempts).toBe(4);
    expect((message.nextAttemptAt as Date).getTime() - AT.getTime()).toBe(8_000);
  });

  test("agendar retry de mensagem já publicada é transição inválida e não altera nada", () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(at(1000));

    expect(() => message.scheduleRetry(at(2000))).toThrow(OutboxMessageAlreadyPublishedError);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toBe(AT);
  });
});

describe("OutboxMessage.rehydrate", () => {
  test("reconstrói o estado sem revalidar, inclusive mensagem já publicada", () => {
    const published = at(5000);
    const message = OutboxMessage.rehydrate({
      id: "evt-7",
      aggregateId: "tx-7",
      eventType: "WagerTransactionRejected",
      payload: { eventId: "evt-7" },
      occurredAt: AT,
      attempts: 4,
      nextAttemptAt: at(1000),
      publishedAt: published,
    });

    expect(message.id).toBe("evt-7");
    expect(message.aggregateId).toBe("tx-7");
    expect(message.eventType).toBe("WagerTransactionRejected");
    expect(message.payload).toEqual({ eventId: "evt-7" });
    expect(message.attempts).toBe(4);
    expect(message.publishedAt).toBe(published);
    expect(message.isPending()).toBe(false);
  });
});
