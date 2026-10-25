import { describe, expect, test } from "bun:test";
import { encodeLedgerCursor } from "../../src/modules/wallet/application/ledger-cursor";
import {
  DEFAULT_LEDGER_LIMIT,
  MAX_LEDGER_LIMIT,
  parseLedgerPageQuery,
} from "../../src/modules/wallet/application/ledger-page-query";
import { InvalidRequestError } from "../../src/shared/application/invalid-request-error";

describe("parseLedgerPageQuery", () => {
  test("sem parâmetros: limit padrão 50 e começa do início", () => {
    expect(parseLedgerPageQuery({ cursor: undefined, limit: undefined })).toEqual({
      afterSeq: undefined,
      limit: 50,
    });
    expect(DEFAULT_LEDGER_LIMIT).toBe(50);
    expect(MAX_LEDGER_LIMIT).toBe(200);
  });

  test.each([
    ["1", 1],
    ["50", 50],
    ["200", 200],
    ["007", 7],
  ])("limit %s vale %d", (raw, expected) => {
    expect(parseLedgerPageQuery({ cursor: undefined, limit: raw }).limit).toBe(expected);
  });

  test.each([
    ["0"],
    ["-1"],
    ["201"],
    ["1000"],
    ["1.5"],
    ["abc"],
    [""],
    [" 5"],
    ["5 "],
    ["1e2"],
    ["+5"],
    ["99999999999999999999"],
    [["1", "2"]],
    [{ a: "1" }],
  ])("recusa limit %j", (limit) => {
    expect(() => parseLedgerPageQuery({ cursor: undefined, limit })).toThrow(InvalidRequestError);
  });

  test("decodifica o cursor para o seq", () => {
    expect(
      parseLedgerPageQuery({ cursor: encodeLedgerCursor("77"), limit: undefined }).afterSeq,
    ).toBe("77");
  });

  test.each([[""], ["!!!"], [["a", "b"]], [{ a: 1 }], [5]])("recusa cursor %j", (cursor) => {
    expect(() => parseLedgerPageQuery({ cursor, limit: undefined })).toThrow(InvalidRequestError);
  });
});
