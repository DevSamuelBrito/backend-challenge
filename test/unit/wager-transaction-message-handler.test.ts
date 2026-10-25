import { describe, expect, test } from "bun:test";
import type { QueueMessage } from "../../src/modules/messaging/application/message-queue.port";
import type {
  InboxContext,
  ProcessWagerTransaction,
} from "../../src/modules/wagering/application/process-wager-transaction";
import type { ProcessWagerTransactionCommand } from "../../src/modules/wagering/application/process-wager-transaction.command";
import { IdempotencyConflictError } from "../../src/modules/wagering/domain/wager-transaction-errors";
import { WagerTransactionMessageHandler } from "../../src/modules/wagering/messaging/wager-transaction-message.handler";
import { LockTimeoutError } from "../../src/shared/application/persistence-errors";

const body = JSON.stringify({
  messageId: "msg-1",
  type: "WagerTransactionRequested",
  occurredAt: "2026-07-29T15:00:00.000Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "tx-1",
    idempotencyKey: "provider-a:tx-1",
    playerId: "player-1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-1",
    gameId: "game-1",
    kind: "BET",
    money: { amount: "10.00", currency: "BRL" },
  },
});

const queueMessage = (messageBody: string): QueueMessage => ({
  sqsMessageId: "sqs-1",
  receiptHandle: "handle-1",
  body: messageBody,
  groupId: "wallet-1",
  deduplicationId: "msg-1",
  receiveCount: 1,
});

function handlerWith(execute: (...args: unknown[]) => unknown) {
  const calls: { command: ProcessWagerTransactionCommand; inbox: InboxContext }[] = [];
  const useCase = {
    execute: async (command: ProcessWagerTransactionCommand, inbox: InboxContext) => {
      calls.push({ command, inbox });
      return execute(command, inbox);
    },
  } as unknown as ProcessWagerTransaction;

  return { handler: new WagerTransactionMessageHandler(useCase), calls };
}

describe("WagerTransactionMessageHandler", () => {
  test("resultado de negócio (qualquer um) vira ack, com o inbox do consumidor e o messageId", async () => {
    const { handler, calls } = handlerWith(() => ({ status: "REJECTED" }));

    expect(await handler.handle(queueMessage(body))).toEqual({ kind: "ack" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.inbox).toEqual({
      consumerName: "wager-transaction-consumer",
      messageId: "msg-1",
    });
    expect(calls[0]?.command.idempotencyKey).toBe("provider-a:tx-1");
  });

  test("mensagem já processada (inbox) vira ack", async () => {
    const { handler } = handlerWith(() => ({ messageAlreadyProcessed: true }));

    expect(await handler.handle(queueMessage(body))).toEqual({ kind: "ack" });
  });

  test("mensagem inválida nem chega ao caso de uso e vai para a DLQ", async () => {
    const { handler, calls } = handlerWith(() => ({ status: "PROCESSED" }));

    const disposition = await handler.handle(queueMessage("{quebrado"));

    expect(disposition).toMatchObject({ kind: "dead-letter", reason: "MALFORMED_MESSAGE" });
    expect(calls).toHaveLength(0);
  });

  test("type errado vai para a DLQ sem chegar ao caso de uso", async () => {
    const { handler, calls } = handlerWith(() => ({ status: "PROCESSED" }));

    const disposition = await handler.handle(
      queueMessage(JSON.stringify({ ...JSON.parse(body), type: "Outro" })),
    );

    expect(disposition).toMatchObject({ kind: "dead-letter", reason: "UNEXPECTED_MESSAGE_TYPE" });
    expect(calls).toHaveLength(0);
  });

  test("erro permanente do caso de uso vai para a DLQ, com o detalhe", async () => {
    const { handler } = handlerWith(() => {
      throw new IdempotencyConflictError("provider-a:tx-1");
    });

    const disposition = await handler.handle(queueMessage(body));

    expect(disposition).toMatchObject({
      kind: "dead-letter",
      reason: "IDEMPOTENCY_CONFLICT",
    });
    expect(disposition.kind === "dead-letter" && disposition.detail).toContain("provider-a:tx-1");
  });

  test("erro transitório do caso de uso vira retry", async () => {
    const { handler } = handlerWith(() => {
      throw new LockTimeoutError(100);
    });

    expect(await handler.handle(queueMessage(body))).toMatchObject({
      kind: "retry",
      reason: "LOCK_TIMEOUT",
    });
  });

  test("erro desconhecido vira retry: na dúvida, tenta de novo", async () => {
    const { handler } = handlerWith(() => {
      throw new Error("???");
    });

    expect(await handler.handle(queueMessage(body))).toMatchObject({
      kind: "retry",
      reason: "UNEXPECTED_ERROR",
    });
  });
});
