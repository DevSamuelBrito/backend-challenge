import { describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { QueueMessage } from "../../src/modules/messaging/application/message-queue.port";
import { SqsMessageQueue } from "../../src/modules/messaging/infrastructure/sqs-message-queue";

interface Sent {
  name: string;
  input: Record<string, unknown>;
  options: { abortSignal?: AbortSignal } | undefined;
}

function fakeClient(reply: (command: Sent) => unknown = defaultReply) {
  const sent: Sent[] = [];
  const client = {
    send: async (
      command: { constructor: { name: string }; input: Record<string, unknown> },
      options?: Sent["options"],
    ) => {
      const record: Sent = { name: command.constructor.name, input: command.input, options };
      sent.push(record);
      return reply(record);
    },
  } as unknown as SQSClient;

  return { client, sent };
}

function defaultReply(command: Sent): unknown {
  if (command.name === "GetQueueUrlCommand") {
    return { QueueUrl: `http://sqs/queue/${command.input.QueueName}` };
  }

  return {};
}

const config = {
  sqs: {
    transactionsQueue: "wager-transactions.fifo",
    transactionsDlq: "wager-transactions-dlq.fifo",
  },
  consumer: { sdkTimeoutMs: 1500 },
} as never;

const target: QueueMessage = {
  sqsMessageId: "sqs-1",
  receiptHandle: "handle-1",
  body: '{"messageId":"msg-1"}',
  groupId: "wallet-1",
  deduplicationId: "msg-1",
  receiveCount: 3,
};

const callsOf = (sent: Sent[], name: string) => sent.filter((call) => call.name === name);

describe("SqsMessageQueue", () => {
  test("receive: long polling, lote, visibilidade e atributos de sistema, e converte as mensagens", async () => {
    const { client, sent } = fakeClient((command) =>
      command.name === "ReceiveMessageCommand"
        ? {
            Messages: [
              {
                MessageId: "sqs-1",
                ReceiptHandle: "handle-1",
                Body: "corpo",
                Attributes: {
                  ApproximateReceiveCount: "4",
                  MessageGroupId: "wallet-1",
                  MessageDeduplicationId: "dedup-1",
                },
              },
            ],
          }
        : defaultReply(command),
    );

    const messages = await new SqsMessageQueue(client, config).receive({
      maxMessages: 7,
      waitSeconds: 5,
      visibilityTimeoutSeconds: 12,
    });

    const receive = callsOf(sent, "ReceiveMessageCommand")[0];
    expect(receive?.input).toMatchObject({
      QueueUrl: "http://sqs/queue/wager-transactions.fifo",
      MaxNumberOfMessages: 7,
      WaitTimeSeconds: 5,
      VisibilityTimeout: 12,
    });
    expect(receive?.input.MessageSystemAttributeNames).toEqual([
      "ApproximateReceiveCount",
      "MessageGroupId",
      "MessageDeduplicationId",
    ]);
    expect(receive?.options?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(messages).toEqual([
      {
        sqsMessageId: "sqs-1",
        receiptHandle: "handle-1",
        body: "corpo",
        groupId: "wallet-1",
        deduplicationId: "dedup-1",
        receiveCount: 4,
      },
    ]);
  });

  test("receive sem mensagens devolve lista vazia e a contagem ausente vale 1", async () => {
    const empty = fakeClient();
    expect(
      await new SqsMessageQueue(empty.client, config).receive({
        maxMessages: 1,
        waitSeconds: 1,
        visibilityTimeoutSeconds: 1,
      }),
    ).toEqual([]);

    const noAttributes = fakeClient((command) =>
      command.name === "ReceiveMessageCommand"
        ? { Messages: [{ MessageId: "m", ReceiptHandle: "h", Body: "b" }] }
        : defaultReply(command),
    );
    const [only] = await new SqsMessageQueue(noAttributes.client, config).receive({
      maxMessages: 1,
      waitSeconds: 1,
      visibilityTimeoutSeconds: 1,
    });

    expect(only?.receiveCount).toBe(1);
    expect(only?.groupId).toBeUndefined();
  });

  test("delete usa o receipt handle da fila de entrada", async () => {
    const { client, sent } = fakeClient();

    await new SqsMessageQueue(client, config).delete(target);

    expect(callsOf(sent, "DeleteMessageCommand")[0]?.input).toEqual({
      QueueUrl: "http://sqs/queue/wager-transactions.fifo",
      ReceiptHandle: "handle-1",
    });
  });

  test("changeVisibility envia o novo prazo em segundos, inclusive zero", async () => {
    const { client, sent } = fakeClient();
    const queue = new SqsMessageQueue(client, config);

    await queue.changeVisibility(target, 8);
    await queue.changeVisibility(target, 0);

    expect(callsOf(sent, "ChangeMessageVisibilityCommand").map((call) => call.input)).toEqual([
      {
        QueueUrl: "http://sqs/queue/wager-transactions.fifo",
        ReceiptHandle: "handle-1",
        VisibilityTimeout: 8,
      },
      {
        QueueUrl: "http://sqs/queue/wager-transactions.fifo",
        ReceiptHandle: "handle-1",
        VisibilityTimeout: 0,
      },
    ]);
  });

  test("sendToDeadLetter envia o corpo original à DLQ com o grupo e a deduplicação da mensagem", async () => {
    const { client, sent } = fakeClient();

    await new SqsMessageQueue(client, config).sendToDeadLetter(target, "WALLET_NOT_FOUND");

    expect(callsOf(sent, "SendMessageCommand")[0]?.input).toEqual({
      QueueUrl: "http://sqs/queue/wager-transactions-dlq.fifo",
      MessageBody: target.body,
      MessageGroupId: "wallet-1",
      MessageDeduplicationId: "msg-1",
      MessageAttributes: {
        failureReason: { DataType: "String", StringValue: "WALLET_NOT_FOUND" },
        sourceQueue: { DataType: "String", StringValue: "wager-transactions.fifo" },
        originalSqsMessageId: { DataType: "String", StringValue: "sqs-1" },
      },
    });
  });

  test("sendToDeadLetter sem grupo ou deduplicação usa o id da mensagem no SQS", async () => {
    const { client, sent } = fakeClient();

    await new SqsMessageQueue(client, config).sendToDeadLetter(
      { ...target, groupId: undefined, deduplicationId: undefined },
      "MALFORMED_MESSAGE",
    );

    const input = callsOf(sent, "SendMessageCommand")[0]?.input;
    expect(input?.MessageGroupId).toBe("sqs-1");
    expect(input?.MessageDeduplicationId).toBe("sqs-1");
  });

  test("a URL de cada fila é resolvida uma vez só e reaproveitada", async () => {
    const { client, sent } = fakeClient();
    const queue = new SqsMessageQueue(client, config);

    await queue.delete(target);
    await queue.delete(target);
    await queue.sendToDeadLetter(target, "X");
    await queue.sendToDeadLetter(target, "X");

    expect(callsOf(sent, "GetQueueUrlCommand").map((call) => call.input.QueueName)).toEqual([
      "wager-transactions.fifo",
      "wager-transactions-dlq.fifo",
    ]);
  });

  test("falha ao resolver a fila não é guardada: a próxima chamada tenta de novo", async () => {
    let failures = 1;
    const { client, sent } = fakeClient((command) => {
      if (command.name === "GetQueueUrlCommand" && failures > 0) {
        failures -= 1;
        throw new Error("SQS fora");
      }

      return defaultReply(command);
    });
    const queue = new SqsMessageQueue(client, config);

    await expect(queue.delete(target)).rejects.toThrow("SQS fora");
    await queue.delete(target);

    expect(callsOf(sent, "GetQueueUrlCommand")).toHaveLength(2);
    expect(callsOf(sent, "DeleteMessageCommand")).toHaveLength(1);
  });

  test("fila sem URL é um erro", async () => {
    const { client } = fakeClient(() => ({}));

    await expect(new SqsMessageQueue(client, config).delete(target)).rejects.toThrow("sem URL");
  });

  test("toda chamada que não é long polling usa o timeout curto do SDK", async () => {
    const { client, sent } = fakeClient();
    const queue = new SqsMessageQueue(client, config);

    await queue.delete(target);
    await queue.changeVisibility(target, 1);
    await queue.sendToDeadLetter(target, "X");

    for (const call of sent) {
      expect(call.options?.abortSignal).toBeInstanceOf(AbortSignal);
    }
  });
});
