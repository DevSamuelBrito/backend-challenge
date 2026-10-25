import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/env";

describe("config: worker de PENDING_REFERENCE", () => {
  test("padrões: 10 tentativas, 15 minutos, tick de 1s, lote de 20", () => {
    expect(loadConfig({}).pendingReference).toEqual({
      maxAttempts: 10,
      ttlMs: 900_000,
      tickIntervalMs: 1000,
      batchSize: 20,
    });
  });

  test("lê os limites do ambiente", () => {
    const config = loadConfig({
      PENDING_REFERENCE_MAX_ATTEMPTS: "3",
      PENDING_REFERENCE_TTL_MS: "5000",
      PENDING_WORKER_INTERVAL_MS: "50",
      PENDING_WORKER_BATCH_SIZE: "7",
    });

    expect(config.pendingReference).toEqual({
      maxAttempts: 3,
      ttlMs: 5000,
      tickIntervalMs: 50,
      batchSize: 7,
    });
  });

  test.each([
    ["PENDING_REFERENCE_MAX_ATTEMPTS", "0"],
    ["PENDING_REFERENCE_TTL_MS", "-1"],
    ["PENDING_WORKER_INTERVAL_MS", "abc"],
    ["PENDING_WORKER_BATCH_SIZE", "1.5"],
  ])("rejeita %s inválido (%s)", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(`${name} inválido`);
  });
});
