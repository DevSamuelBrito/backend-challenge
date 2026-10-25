import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/modules/wagering/domain/failure-code";
import {
  backoffDelayMs,
  exhaustionFailureCode,
  isReferenceWaitExhausted,
} from "../../src/modules/wagering/domain/pending-reference-policy";

const LIMITS = { maxAttempts: 10, ttlMs: 15 * 60 * 1000 };
const CREATED = new Date("2031-05-05T10:00:00.000Z");
const after = (ms: number) => new Date(CREATED.getTime() + ms);

describe("backoffDelayMs: 2^n segundos com teto de 60s", () => {
  test("a série é 1s, 2s, 4s, 8s, 16s, 32s e depois 60s", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(backoffDelayMs)).toEqual(
      [1, 2, 4, 8, 16, 32, 60, 60, 60, 60, 60].map((seconds) => seconds * 1000),
    );
  });

  test("tentativas enormes continuam presas no teto (sem overflow)", () => {
    expect(backoffDelayMs(1000)).toBe(60_000);
    expect(backoffDelayMs(Number.MAX_SAFE_INTEGER)).toBe(60_000);
  });

  test.each([-1, 1.5, Number.NaN])("rejeita tentativas inválidas (%p)", (attempts) => {
    expect(() => backoffDelayMs(attempts)).toThrow(RangeError);
  });
});

describe("isReferenceWaitExhausted: o que vier primeiro, tentativas ou tempo", () => {
  test("não esgota abaixo dos dois limites", () => {
    expect(isReferenceWaitExhausted(9, CREATED, after(14 * 60 * 1000), LIMITS)).toBe(false);
  });

  test("esgota ao atingir o número de tentativas, mesmo sem passar tempo", () => {
    expect(isReferenceWaitExhausted(10, CREATED, after(1000), LIMITS)).toBe(true);
    expect(isReferenceWaitExhausted(11, CREATED, after(1000), LIMITS)).toBe(true);
  });

  test("esgota ao atingir o TTL, mesmo com poucas tentativas (limite inclusivo)", () => {
    expect(isReferenceWaitExhausted(1, CREATED, after(15 * 60 * 1000 - 1), LIMITS)).toBe(false);
    expect(isReferenceWaitExhausted(1, CREATED, after(15 * 60 * 1000), LIMITS)).toBe(true);
    expect(isReferenceWaitExhausted(1, CREATED, after(60 * 60 * 1000), LIMITS)).toBe(true);
  });

  test("os limites vêm da configuração", () => {
    expect(isReferenceWaitExhausted(3, CREATED, after(0), { maxAttempts: 3, ttlMs: 1e9 })).toBe(
      true,
    );
    expect(
      isReferenceWaitExhausted(1, CREATED, after(10_000), { maxAttempts: 99, ttlMs: 10_000 }),
    ).toBe(true);
  });
});

describe("exhaustionFailureCode", () => {
  test("referência inexistente => REFERENCE_NOT_FOUND", () => {
    expect(exhaustionFailureCode(false)).toBe(FailureCode.ReferenceNotFound);
  });

  test("referência existente que nunca saiu de PENDING => REFERENCE_NOT_PROCESSED", () => {
    expect(exhaustionFailureCode(true)).toBe(FailureCode.ReferenceNotProcessed);
  });
});
