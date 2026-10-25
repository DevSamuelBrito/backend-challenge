import { describe, expect, test } from "bun:test";
import { visibilityBackoffSeconds } from "../../src/modules/messaging/application/visibility-backoff";

describe("visibilityBackoffSeconds: min(2^(n-1) * base, teto)", () => {
  test("com base 1 e teto 60: 1, 2, 4, 8, 16, 32, 60...", () => {
    const backoff = { baseSeconds: 1, maxSeconds: 60 };

    expect(
      [1, 2, 3, 4, 5, 6, 7, 8].map((count) => visibilityBackoffSeconds(count, backoff)),
    ).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });

  test("a base multiplica a progressão", () => {
    const backoff = { baseSeconds: 5, maxSeconds: 1000 };

    expect([1, 2, 3, 4].map((count) => visibilityBackoffSeconds(count, backoff))).toEqual([
      5, 10, 20, 40,
    ]);
  });

  test("o teto nunca é ultrapassado, nem com contagens enormes", () => {
    const backoff = { baseSeconds: 1, maxSeconds: 60 };

    expect(visibilityBackoffSeconds(1_000, backoff)).toBe(60);
    expect(visibilityBackoffSeconds(Number.MAX_SAFE_INTEGER, backoff)).toBe(60);
  });

  test("contagem inválida (0 ou negativa) vale como a primeira tentativa", () => {
    const backoff = { baseSeconds: 2, maxSeconds: 60 };

    expect(visibilityBackoffSeconds(0, backoff)).toBe(2);
    expect(visibilityBackoffSeconds(-3, backoff)).toBe(2);
  });
});
