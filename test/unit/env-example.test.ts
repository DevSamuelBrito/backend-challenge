import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadConfig } from "../../src/config/env";

const example = readFileSync(".env.example", "utf8");

const active = Object.fromEntries(
  example
    .split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => {
      const separator = line.indexOf("=");

      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const documented = new Set(
  [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] as string),
);

const read = new Set(
  [...readFileSync("src/config/env.ts", "utf8").matchAll(/(?:env\.|")([A-Z][A-Z0-9_]{3,})\b/g)].map(
    (match) => match[1] as string,
  ),
);

describe(".env.example", () => {
  test("os valores ativos são exatamente os padrões da aplicação", () => {
    expect(loadConfig(active)).toEqual(loadConfig({}));
  });

  test("documenta toda variável que a configuração lê", () => {
    expect([...read].filter((name) => !documented.has(name)).sort()).toEqual([]);
  });

  test("a injeção de falha vem desligada", () => {
    expect(active.ENABLE_FAULT_INJECTION).toBeUndefined();
    expect(active.FAULT_POINT).toBeUndefined();
  });
});
