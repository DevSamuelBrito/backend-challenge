import { describe, expect, test } from "bun:test";
import { validCorrelationId } from "../../src/shared/application/correlation-id";

describe("validCorrelationId", () => {
  test.each([
    ["0192f298-345e-7e38-af88-e43f851a819d"],
    ["req-123"],
    ["msg_123.abc:def"],
    ["a"],
    ["A".repeat(128)],
    ["1234567890"],
  ])("aceita %s", (value) => {
    expect(validCorrelationId(value)).toBe(value);
  });

  test.each([
    [""],
    [" "],
    ["com espaço"],
    ["A".repeat(129)],
    ["-começa-com-hífen"],
    [".começa-com-ponto"],
    ["a,b"],
    ["a;b"],
    ["linha\nquebrada"],
    ["<script>"],
    ["acentuação"],
    ["a/b"],
  ])("recusa %j", (value) => {
    expect(validCorrelationId(value)).toBeUndefined();
  });

  test.each([[undefined], [null], [42], [["a", "b"]], [{}]])(
    "recusa o que não é texto (%j)",
    (value) => {
      expect(validCorrelationId(value)).toBeUndefined();
    },
  );
});
