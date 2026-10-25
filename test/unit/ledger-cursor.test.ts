import { describe, expect, test } from "bun:test";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from "../../src/modules/wallet/application/ledger-cursor";
import { InvalidRequestError } from "../../src/shared/application/invalid-request-error";

const raw = (text: string) => Buffer.from(text, "utf8").toString("base64url");

describe("cursor do ledger", () => {
  test("ida e volta preserva o seq, inclusive acima de Number.MAX_SAFE_INTEGER", () => {
    for (const seq of ["1", "42", "9007199254740993", "9223372036854775807"]) {
      expect(decodeLedgerCursor(encodeLedgerCursor(seq))).toBe(seq);
    }
  });

  test("é base64url (sem +, / ou =) e não contém o seq em texto puro", () => {
    const cursor = encodeLedgerCursor("123456");

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("123456");
    expect(cursor).not.toBe(Buffer.from("123456").toString("base64url"));
  });

  test.each([
    ["vazio", ""],
    ["lixo", "!!!"],
    ["base64 válido que não é um cursor", raw("hello")],
    ["só o seq, sem o prefixo", raw("42")],
    ["prefixo de outra versão", raw("l2:42")],
    ["seq não numérico", raw("l1:abc")],
    ["seq zero", raw("l1:0")],
    ["seq negativo", raw("l1:-5")],
    ["seq com zero à esquerda", raw("l1:042")],
    ["seq decimal", raw("l1:4.2")],
    ["seq acima de bigint", raw("l1:9223372036854775808")],
    ["seq com espaço", raw("l1: 42")],
    ["seq com sufixo", raw("l1:42x")],
    ["com padding =", `${encodeLedgerCursor("42")}=`],
    ["em base64 comum com + e /", Buffer.from("l1:42", "utf8").toString("base64") + "=="],
    ["adulterado: caractere do prefixo trocado", encodeLedgerCursor("42").replace("DE6", "DF6")],
  ])("recusa cursor %s", (_name, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidRequestError);
  });
});
