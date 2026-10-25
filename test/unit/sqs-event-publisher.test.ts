import { describe, expect, test } from "bun:test";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { OutboundEvent } from "../../src/modules/messaging/application/event-publisher.port";
import { SqsEventPublisher } from "../../src/modules/messaging/infrastructure/sqs-event-publisher";

interface Sent {
  name: string;
  input: Record<string, unknown>;
  options: { abortSignal?: AbortSignal } | undefined;
}

type Reply = (command: Sent) => unknown;

function fakeClient(reply: Reply) {
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

const config = {
  sqs: { eventsQueue: "wager-events.fifo" },
  outbox: { sendTimeoutMs: 1234 },
} as never;

const event = (index: number): OutboundEvent => ({
  eventId: `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
  eventType: "WalletBalanceChanged",
  groupId: `wallet-${index % 3}`,
  body: JSON.stringify({ index }),
});

const okReply: Reply = (command) => {
  if (command.name === "GetQueueUrlCommand") {
    return { QueueUrl: "http://sqs/queue/wager-events.fifo" };
  }

  const entries = command.input.Entries as { Id: string }[];
  return { Successful: entries.map((entry) => ({ Id: entry.Id })), Failed: [] };
};

describe("SqsEventPublisher", () => {
  test("monta a entrada com group id, deduplication id = eventId e atributos eventType/eventId", async () => {
    const { client, sent } = fakeClient(okReply);

    const outcomes = await new SqsEventPublisher(client, config).publish([event(1)]);

    expect(outcomes).toEqual([{ eventId: event(1).eventId, confirmed: true }]);
    const batch = sent.find((call) => call.name === "SendMessageBatchCommand");
    expect(batch?.input.QueueUrl).toBe("http://sqs/queue/wager-events.fifo");
    expect(batch?.input.Entries).toEqual([
      {
        Id: event(1).eventId,
        MessageBody: event(1).body,
        MessageGroupId: "wallet-1",
        MessageDeduplicationId: event(1).eventId,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: "WalletBalanceChanged" },
          eventId: { DataType: "String", StringValue: event(1).eventId },
        },
      },
    ]);
  });

  test("resolve o nome da fila de eventos configurada, e nada mais", async () => {
    const { client, sent } = fakeClient(okReply);

    await new SqsEventPublisher(client, config).publish([event(1)]);

    expect(sent[0]?.name).toBe("GetQueueUrlCommand");
    expect(sent[0]?.input).toEqual({ QueueName: "wager-events.fifo" });
  });

  test("a URL da fila é resolvida uma vez só e reaproveitada", async () => {
    const { client, sent } = fakeClient(okReply);
    const publisher = new SqsEventPublisher(client, config);

    await publisher.publish([event(1)]);
    await publisher.publish([event(2)]);

    expect(sent.filter((call) => call.name === "GetQueueUrlCommand")).toHaveLength(1);
  });

  test("toda chamada ao SDK leva um AbortSignal (timeout curto)", async () => {
    const { client, sent } = fakeClient(okReply);

    await new SqsEventPublisher(client, config).publish([event(1)]);

    expect(sent.length).toBe(2);
    for (const call of sent) {
      expect(call.options?.abortSignal).toBeInstanceOf(AbortSignal);
    }
  });

  test("25 eventos viram 3 chamadas de lote (10 + 10 + 5), na ordem recebida", async () => {
    const { client, sent } = fakeClient(okReply);
    const events = Array.from({ length: 25 }, (_, index) => event(index));

    const outcomes = await new SqsEventPublisher(client, config).publish(events);

    const batches = sent.filter((call) => call.name === "SendMessageBatchCommand");
    expect(batches.map((call) => (call.input.Entries as unknown[]).length)).toEqual([10, 10, 5]);
    expect(
      batches.flatMap((call) => (call.input.Entries as { Id: string }[]).map((e) => e.Id)),
    ).toEqual(events.map((e) => e.eventId));
    expect(outcomes.every((outcome) => outcome.confirmed)).toBe(true);
  });

  test("falha PARCIAL: só as entradas em Failed ficam sem confirmação, com o motivo do SQS", async () => {
    const { client } = fakeClient((command) => {
      if (command.name === "GetQueueUrlCommand") {
        return { QueueUrl: "http://sqs/q" };
      }
      return {
        Successful: [{ Id: event(1).eventId }, { Id: event(3).eventId }],
        Failed: [
          { Id: event(2).eventId, Code: "InvalidParameterValue", Message: "grupo inválido" },
        ],
      };
    });

    const outcomes = await new SqsEventPublisher(client, config).publish([
      event(1),
      event(2),
      event(3),
    ]);

    expect(outcomes).toEqual([
      { eventId: event(1).eventId, confirmed: true },
      {
        eventId: event(2).eventId,
        confirmed: false,
        reason: "InvalidParameterValue: grupo inválido",
      },
      { eventId: event(3).eventId, confirmed: true },
    ]);
  });

  test("entrada ausente da resposta nunca é tratada como confirmada", async () => {
    const { client } = fakeClient((command) =>
      command.name === "GetQueueUrlCommand"
        ? { QueueUrl: "http://sqs/q" }
        : { Successful: [{ Id: event(1).eventId }] },
    );

    const outcomes = await new SqsEventPublisher(client, config).publish([event(1), event(2)]);

    expect(outcomes[0]).toEqual({ eventId: event(1).eventId, confirmed: true });
    expect(outcomes[1]).toMatchObject({ eventId: event(2).eventId, confirmed: false });
  });

  test("chamada inteira falha: o lote e os seguintes ficam sem confirmação e nenhum lote posterior é enviado", async () => {
    let batchCalls = 0;
    const { client, sent } = fakeClient((command) => {
      if (command.name === "GetQueueUrlCommand") {
        return { QueueUrl: "http://sqs/q" };
      }
      batchCalls += 1;
      if (batchCalls === 2) {
        throw new Error("rede caiu");
      }
      const entries = command.input.Entries as { Id: string }[];
      return { Successful: entries.map((entry) => ({ Id: entry.Id })) };
    });
    const events = Array.from({ length: 25 }, (_, index) => event(index));

    const outcomes = await new SqsEventPublisher(client, config).publish(events);

    expect(outcomes.slice(0, 10).every((outcome) => outcome.confirmed)).toBe(true);
    expect(outcomes.slice(10).every((outcome) => !outcome.confirmed)).toBe(true);
    expect(outcomes).toHaveLength(25);
    expect(sent.filter((call) => call.name === "SendMessageBatchCommand")).toHaveLength(2);
    expect(outcomes[10]).toMatchObject({ reason: expect.stringContaining("rede caiu") });
  });

  test("falha ao resolver a fila: tudo sem confirmação, e a próxima chamada tenta resolver de novo", async () => {
    let urlCalls = 0;
    const { client, sent } = fakeClient((command) => {
      if (command.name === "GetQueueUrlCommand") {
        urlCalls += 1;
        if (urlCalls === 1) {
          throw new Error("QueueDoesNotExist");
        }
        return { QueueUrl: "http://sqs/q" };
      }
      const entries = command.input.Entries as { Id: string }[];
      return { Successful: entries.map((entry) => ({ Id: entry.Id })) };
    });
    const publisher = new SqsEventPublisher(client, config);

    const first = await publisher.publish([event(1)]);
    const second = await publisher.publish([event(1)]);

    expect(first).toMatchObject([
      { confirmed: false, reason: expect.stringContaining("QueueDoesNotExist") },
    ]);
    expect(second).toEqual([{ eventId: event(1).eventId, confirmed: true }]);
    expect(sent.filter((call) => call.name === "GetQueueUrlCommand")).toHaveLength(2);
  });
});
