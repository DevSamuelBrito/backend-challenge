import { describe, expect, test } from "bun:test";
import { InboxMessage } from "../../src/modules/messaging/domain/inbox-message";
import { InboxMessageAlreadyProcessedError } from "../../src/modules/messaging/domain/messaging-errors";
import { DomainError } from "../../src/shared/domain/domain-error";
import { AT } from "../support/wagering-builders";

const LATER = new Date("2026-01-01T12:00:05.000Z");

const receive = () =>
  InboxMessage.receive({
    messageId: "msg-123",
    consumerName: "wager-transactions",
    payloadHash: "hash-abc",
    receivedAt: AT,
  });

describe("InboxMessage.receive", () => {
  test("nasce recebida e ainda não processada", () => {
    const message = receive();

    expect(message.messageId).toBe("msg-123");
    expect(message.consumerName).toBe("wager-transactions");
    expect(message.payloadHash).toBe("hash-abc");
    expect(message.receivedAt).toBe(AT);
    expect(message.processedAt).toBeUndefined();
    expect(message.isProcessed()).toBe(false);
  });
});

describe("InboxMessage.markProcessed", () => {
  test("marca como processada e guarda o instante", () => {
    const message = receive();

    message.markProcessed(LATER);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(LATER);
  });

  test("processar de novo é transição inválida e não altera o instante original", () => {
    const message = receive();
    message.markProcessed(LATER);

    expect(() => message.markProcessed(new Date("2026-02-01T00:00:00.000Z"))).toThrow(
      InboxMessageAlreadyProcessedError,
    );
    expect(message.processedAt).toBe(LATER);
  });

  test("o erro é de domínio, tem código estável e cita consumidor e mensagem", () => {
    const message = receive();
    message.markProcessed(LATER);

    try {
      message.markProcessed(LATER);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as InboxMessageAlreadyProcessedError).code).toBe(
        "INBOX_MESSAGE_ALREADY_PROCESSED",
      );
      expect((error as Error).message).toContain("msg-123");
      expect((error as Error).message).toContain("wager-transactions");
    }
  });
});

describe("InboxMessage.matchesPayload", () => {
  test("compara o hash do payload (mesmo messageId com payload diferente é produtor quebrado)", () => {
    const message = receive();

    expect(message.matchesPayload("hash-abc")).toBe(true);
    expect(message.matchesPayload("hash-xyz")).toBe(false);
  });
});

describe("InboxMessage.rehydrate", () => {
  test("reconstrói uma mensagem já processada", () => {
    const message = InboxMessage.rehydrate({
      messageId: "msg-1",
      consumerName: "c",
      payloadHash: "h",
      receivedAt: AT,
      processedAt: LATER,
    });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toBe(LATER);
    expect(() => message.markProcessed(LATER)).toThrow(InboxMessageAlreadyProcessedError);
  });

  test("reconstrói uma mensagem ainda não processada, que pode ser processada", () => {
    const message = InboxMessage.rehydrate({
      messageId: "msg-1",
      consumerName: "c",
      payloadHash: "h",
      receivedAt: AT,
    });

    expect(message.isProcessed()).toBe(false);
    expect(() => message.markProcessed(LATER)).not.toThrow();
  });
});
