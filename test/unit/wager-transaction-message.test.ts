import { describe, expect, test } from "bun:test";
import { computePayloadHash } from "../../src/modules/wagering/application/payload-hash";
import { parseProcessWagerTransactionCommand } from "../../src/modules/wagering/application/process-wager-transaction.command";
import {
  MalformedMessageError,
  UnexpectedMessageTypeError,
} from "../../src/modules/wagering/messaging/message-errors";
import { parseWagerTransactionMessage } from "../../src/modules/wagering/messaging/wager-transaction-message";
import { InvalidRequestError } from "../../src/shared/application/invalid-request-error";
import { InvalidMoneyError } from "../../src/shared/domain/money";

const data = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  idempotencyKey: "provider-a:transaction-123",
  playerId: "player-1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

const message = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    messageId: "msg-123",
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data,
    ...overrides,
  });

describe("parseWagerTransactionMessage", () => {
  test("lê o messageId e monta o comando a partir de data, com a idempotencyKey de dentro de data", () => {
    const parsed = parseWagerTransactionMessage(message());

    expect(parsed.messageId).toBe("msg-123");
    expect(parsed.command.idempotencyKey).toBe("provider-a:transaction-123");
    expect(parsed.command).toMatchObject({
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      playerId: "player-1",
      walletId: data.walletId,
      kind: "BET",
    });
    expect(parsed.command.money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  test("o payloadHash é o mesmo do HTTP para o mesmo conteúdo, e ignora a idempotencyKey", () => {
    const { idempotencyKey, ...payload } = data;
    const viaHttp = parseProcessWagerTransactionCommand({ idempotencyKey: "outra-chave", payload });
    const viaSqs = parseWagerTransactionMessage(message()).command;

    expect(idempotencyKey).not.toBe("outra-chave");
    expect(computePayloadHash(viaSqs)).toBe(computePayloadHash(viaHttp));
  });

  test("referenceExternalTransactionId passa para o comando em WIN/LOSS/REFUND/ROLLBACK", () => {
    const parsed = parseWagerTransactionMessage(
      message({
        data: { ...data, kind: "REFUND", referenceExternalTransactionId: "bet-1" },
      }),
    );

    expect(parsed.command.referenceExternalTransactionId).toBe("bet-1");
  });

  test("JSON inválido é uma mensagem malformada", () => {
    expect(() => parseWagerTransactionMessage("{não é json")).toThrow(MalformedMessageError);
    expect(() => parseWagerTransactionMessage("")).toThrow(MalformedMessageError);
  });

  test.each([["[]"], ["123"], ['"texto"'], ["null"], ["true"]])(
    "corpo que não é um objeto (%s) é malformado",
    (body) => {
      expect(() => parseWagerTransactionMessage(body)).toThrow(MalformedMessageError);
    },
  );

  test.each([
    [{ type: "Outro" }],
    [{ type: undefined }],
    [{ type: "wagertransactionrequested" }],
    [{ type: 5 }],
  ])("type diferente de WagerTransactionRequested (%o) é recusado", (overrides) => {
    expect(() => parseWagerTransactionMessage(message(overrides))).toThrow(
      UnexpectedMessageTypeError,
    );
  });

  test.each([
    [{ messageId: undefined }],
    [{ messageId: "" }],
    [{ messageId: "   " }],
    [{ messageId: 7 }],
    [{ messageId: "x".repeat(256) }],
    [{ data: undefined }],
    [{ data: null }],
    [{ data: [] }],
    [{ data: "texto" }],
    [{ data: { ...data, idempotencyKey: undefined } }],
    [{ data: { ...data, idempotencyKey: "" } }],
    [{ data: { ...data, idempotencyKey: 12 } }],
    [{ data: { ...data, providerId: undefined } }],
    [{ data: { ...data, walletId: "não-é-uuid" } }],
    [{ data: { ...data, kind: "OPENING" } }],
    [{ data: { ...data, kind: "TIP" } }],
    [{ data: { ...data, kind: "REFUND" } }],
    [{ data: { ...data, kind: "BET", referenceExternalTransactionId: "x" } }],
  ])("payload inválido (%o) é um erro de validação", (overrides) => {
    expect(() => parseWagerTransactionMessage(message(overrides))).toThrow(InvalidRequestError);
  });

  test.each([["10.555"], ["10.5"], ["1e3"], ["-1.00"], ["0.00"], [""], ["abc"]])(
    "valor %s é recusado como o HTTP recusaria",
    (amount) => {
      expect(() =>
        parseWagerTransactionMessage(
          message({ data: { ...data, money: { amount, currency: "BRL" } } }),
        ),
      ).toThrow(InvalidMoneyError);
    },
  );

  test("o type é verificado antes do restante: mensagem de outro tipo nunca chega a validar os dados", () => {
    expect(() =>
      parseWagerTransactionMessage(message({ type: "Outro", data: "lixo", messageId: 1 })),
    ).toThrow(UnexpectedMessageTypeError);
  });
});
