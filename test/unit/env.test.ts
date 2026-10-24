import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/env";

describe("loadConfig: DB_LOCK_TIMEOUT_MS", () => {
  test("padrão de 5 segundos", () => {
    expect(loadConfig({}).databaseLockTimeoutMs).toBe(5000);
  });

  test("aceita um valor configurado", () => {
    expect(loadConfig({ DB_LOCK_TIMEOUT_MS: "250" }).databaseLockTimeoutMs).toBe(250);
  });

  test("recusa zero, negativo, fracionário e texto", () => {
    for (const invalid of ["0", "-5", "1.5", "abc", ""]) {
      expect(() => loadConfig({ DB_LOCK_TIMEOUT_MS: invalid })).toThrow(/DB_LOCK_TIMEOUT_MS/);
    }
  });
});
