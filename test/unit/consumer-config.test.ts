import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/env";

describe("config: consumidor da fila de entrada", () => {
  test("padrões", () => {
    expect(loadConfig({}).consumer).toEqual({
      waitSeconds: 20,
      batchSize: 10,
      concurrency: 5,
      visibilityTimeoutSeconds: 30,
      backoffBaseSeconds: 1,
      backoffMaxSeconds: 60,
      sdkTimeoutMs: 5000,
      shutdownTimeoutMs: 30_000,
    });
  });

  test("lê os valores do ambiente", () => {
    const config = loadConfig({
      CONSUMER_WAIT_SECONDS: "2",
      CONSUMER_BATCH_SIZE: "4",
      CONSUMER_CONCURRENCY: "8",
      CONSUMER_VISIBILITY_TIMEOUT_SECONDS: "9",
      CONSUMER_BACKOFF_BASE_SECONDS: "3",
      CONSUMER_BACKOFF_MAX_SECONDS: "30",
      CONSUMER_SDK_TIMEOUT_MS: "700",
      CONSUMER_SHUTDOWN_TIMEOUT_MS: "1500",
    });

    expect(config.consumer).toEqual({
      waitSeconds: 2,
      batchSize: 4,
      concurrency: 8,
      visibilityTimeoutSeconds: 9,
      backoffBaseSeconds: 3,
      backoffMaxSeconds: 30,
      sdkTimeoutMs: 700,
      shutdownTimeoutMs: 1500,
    });
  });

  test.each([
    ["CONSUMER_WAIT_SECONDS", "0"],
    ["CONSUMER_WAIT_SECONDS", "21"],
    ["CONSUMER_BATCH_SIZE", "0"],
    ["CONSUMER_BATCH_SIZE", "11"],
    ["CONSUMER_CONCURRENCY", "0"],
    ["CONSUMER_CONCURRENCY", "1.5"],
    ["CONSUMER_VISIBILITY_TIMEOUT_SECONDS", "0"],
    ["CONSUMER_VISIBILITY_TIMEOUT_SECONDS", "43201"],
    ["CONSUMER_BACKOFF_BASE_SECONDS", "-1"],
    ["CONSUMER_BACKOFF_MAX_SECONDS", "abc"],
    ["CONSUMER_SDK_TIMEOUT_MS", "0"],
    ["CONSUMER_SHUTDOWN_TIMEOUT_MS", "-5"],
  ])("rejeita %s inválido (%s)", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(`${name} inválido`);
  });

  test("o teto do backoff não pode ser menor que a base", () => {
    expect(() =>
      loadConfig({ CONSUMER_BACKOFF_BASE_SECONDS: "10", CONSUMER_BACKOFF_MAX_SECONDS: "5" }),
    ).toThrow("CONSUMER_BACKOFF_MAX_SECONDS");
  });

  test("as filas padrão são wager-transactions.fifo e a DLQ wager-transactions-dlq.fifo", () => {
    const { sqs } = loadConfig({});

    expect(sqs.transactionsQueue).toBe("wager-transactions.fifo");
    expect(sqs.transactionsDlq).toBe("wager-transactions-dlq.fifo");
  });

  test("a fila de entrada NUNCA pode ser a fila de eventos", () => {
    expect(() =>
      loadConfig({ SQS_TRANSACTIONS_QUEUE: "mesma.fifo", SQS_EVENTS_QUEUE: "mesma.fifo" }),
    ).toThrow("SQS_EVENTS_QUEUE não pode ser a fila de entrada");
  });

  test("a DLQ não pode ser a própria fila de entrada", () => {
    expect(() =>
      loadConfig({ SQS_TRANSACTIONS_QUEUE: "mesma.fifo", SQS_TRANSACTIONS_DLQ: "mesma.fifo" }),
    ).toThrow("SQS_TRANSACTIONS_DLQ não pode ser a própria fila de entrada");
  });
});
