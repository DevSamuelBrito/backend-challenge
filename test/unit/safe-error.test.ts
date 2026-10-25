import { describe, expect, test } from "bun:test";
import {
  describeError,
  stackFramesOf,
  summarizeError,
} from "../../src/shared/application/safe-error";

describe("resumo seguro de erros", () => {
  test("devolve nome e código, nunca a mensagem", () => {
    const error = Object.assign(
      new TypeError("Key (idempotency_key)=(segredo-123) already exists"),
      {
        code: "23505",
      },
    );

    expect(summarizeError(error)).toEqual({ errorName: "TypeError", errorCode: "23505" });
    expect(describeError(error)).toBe("TypeError (23505)");
    expect(JSON.stringify(summarizeError(error))).not.toContain("segredo-123");
  });

  test("sem código, só o nome", () => {
    expect(summarizeError(new Error("x"))).toEqual({ errorName: "Error" });
    expect(describeError(new Error("x"))).toBe("Error");
  });

  test("valores que não são Error viram o tipo, sem o conteúdo", () => {
    expect(summarizeError("texto com 123456.78")).toEqual({ errorName: "string" });
    expect(describeError({ amount: "123456.78" })).toBe("object");
    expect(describeError(undefined)).toBe("undefined");
  });

  test("código que não é string é ignorado", () => {
    expect(summarizeError(Object.assign(new Error("x"), { code: 500 }))).toEqual({
      errorName: "Error",
    });
  });

  test("os frames do stack não incluem a mensagem", () => {
    const frames = stackFramesOf(new Error("mensagem-secreta-123456.78"));

    expect(frames).toBeDefined();
    expect(frames).not.toContain("mensagem-secreta");
    expect(frames?.split("\n").every((line) => line.trimStart().startsWith("at "))).toBe(true);
  });

  test("sem stack ou sem Error, não há frames", () => {
    expect(stackFramesOf("x")).toBeUndefined();
    expect(stackFramesOf(Object.assign(new Error("x"), { stack: undefined }))).toBeUndefined();
  });
});
