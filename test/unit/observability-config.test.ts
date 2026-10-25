import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/env";

describe("config: observabilidade", () => {
  test("padrões: nível info e métricas default ligadas", () => {
    expect(loadConfig({}).observability).toEqual({ logLevel: "info", defaultMetrics: true });
  });

  test.each(["fatal", "error", "warn", "info", "debug", "trace", "silent"])(
    "aceita LOG_LEVEL=%s",
    (level) => {
      expect(loadConfig({ LOG_LEVEL: level }).observability.logLevel).toBe(level as never);
    },
  );

  test("LOG_LEVEL ignora maiúsculas", () => {
    expect(loadConfig({ LOG_LEVEL: "DEBUG" }).observability.logLevel).toBe("debug");
  });

  test.each([["verbose"], [""], ["tudo"]])("rejeita LOG_LEVEL=%j", (level) => {
    expect(() => loadConfig({ LOG_LEVEL: level })).toThrow("LOG_LEVEL inválido");
  });

  test("METRICS_DEFAULT_METRICS aceita true e false e rejeita o resto", () => {
    expect(loadConfig({ METRICS_DEFAULT_METRICS: "false" }).observability.defaultMetrics).toBe(
      false,
    );
    expect(loadConfig({ METRICS_DEFAULT_METRICS: "TRUE" }).observability.defaultMetrics).toBe(true);
    expect(() => loadConfig({ METRICS_DEFAULT_METRICS: "sim" })).toThrow(
      "METRICS_DEFAULT_METRICS inválido",
    );
  });
});
