import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/env";

describe("config: publisher da outbox", () => {
  test("padrões: tick de 1s, lote de 10, timeout de 3s e alerta após 10 tentativas", () => {
    expect(loadConfig({}).outbox).toEqual({
      tickIntervalMs: 1000,
      batchSize: 10,
      sendTimeoutMs: 3000,
      alertAttempts: 10,
    });
  });

  test("lê os valores do ambiente", () => {
    const config = loadConfig({
      OUTBOX_INTERVAL_MS: "50",
      OUTBOX_BATCH_SIZE: "25",
      OUTBOX_SEND_TIMEOUT_MS: "500",
      OUTBOX_ALERT_ATTEMPTS: "3",
    });

    expect(config.outbox).toEqual({
      tickIntervalMs: 50,
      batchSize: 25,
      sendTimeoutMs: 500,
      alertAttempts: 3,
    });
  });

  test.each([
    ["OUTBOX_INTERVAL_MS", "0"],
    ["OUTBOX_BATCH_SIZE", "-5"],
    ["OUTBOX_SEND_TIMEOUT_MS", "abc"],
    ["OUTBOX_ALERT_ATTEMPTS", "1.5"],
  ])("rejeita %s inválido (%s)", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(`${name} inválido`);
  });

  test("a fila de eventos padrão é wager-events.fifo", () => {
    expect(loadConfig({}).sqs.eventsQueue).toBe("wager-events.fifo");
  });

  test("a fila de eventos NUNCA pode ser a fila de entrada nem a DLQ", () => {
    expect(() =>
      loadConfig({
        SQS_EVENTS_QUEUE: "wager-transactions.fifo",
      }),
    ).toThrow("SQS_EVENTS_QUEUE não pode ser a fila de entrada");
    expect(() =>
      loadConfig({
        SQS_EVENTS_QUEUE: "wager-transactions-dlq.fifo",
      }),
    ).toThrow("SQS_EVENTS_QUEUE não pode ser a fila de entrada");
    expect(() =>
      loadConfig({
        SQS_EVENTS_QUEUE: "minha-fila.fifo",
        SQS_TRANSACTIONS_QUEUE: "minha-fila.fifo",
      }),
    ).toThrow("SQS_EVENTS_QUEUE não pode ser a fila de entrada");
  });
});
