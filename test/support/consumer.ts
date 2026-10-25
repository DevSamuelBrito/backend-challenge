import { randomUUID } from "node:crypto";
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { AppConfig } from "../../src/config/env";
import type {
  MessageQueue,
  QueueMessage,
  ReceiveOptions,
} from "../../src/modules/messaging/application/message-queue.port";
import { SqsMessageQueue } from "../../src/modules/messaging/infrastructure/sqs-message-queue";
import { WagerTransactionConsumer } from "../../src/modules/wagering/messaging/wager-transaction.consumer";
import { newSqsClient } from "./outbox";
import { testConfig } from "./test-config";
import type { WagerPayload } from "./wagering-api";
import type { AppInstance } from "./wallet-api";

export const MAX_RECEIVE_COUNT = 5;

export interface DeadLetter {
  body: string;
  rawBody: unknown;
  groupId: string | undefined;
  deduplicationId: string | undefined;
  failureReason: string | undefined;
}

export interface SendOptions {
  groupId?: string;
  deduplicationId?: string;
}

export interface InputQueues {
  inputName: string;
  dlqName: string;
  create(): Promise<void>;
  purge(): Promise<void>;
  send(message: unknown, options?: SendOptions): Promise<void>;
  inputDepth(): Promise<number>;
  dlqDepth(): Promise<number>;
  drainDlq(expected?: number, timeoutMs?: number): Promise<DeadLetter[]>;
  takeFromInput(max?: number): Promise<{ body: string; receiveCount: number }[]>;
  close(): Promise<void>;
}

export interface QueueOptions {
  visibilityTimeoutSeconds?: number;
}

export async function createInputQueues(options: QueueOptions = {}): Promise<InputQueues> {
  const client = newSqsClient();
  const suffix = randomUUID();
  const inputName = `wager-transactions-test-${suffix}.fifo`;
  const dlqName = `wager-transactions-dlq-test-${suffix}.fifo`;
  let inputUrl: string | undefined;
  let dlqUrl: string | undefined;

  const requireUrl = (url: string | undefined): string => {
    if (!url) {
      throw new Error("as filas de teste ainda não foram criadas");
    }

    return url;
  };

  const depth = async (queueUrl: string): Promise<number> => {
    const { Attributes } = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
          "ApproximateNumberOfMessagesDelayed",
        ],
      }),
    );

    return Object.values(Attributes ?? {}).reduce((sum, value) => sum + Number(value), 0);
  };

  const queues: InputQueues = {
    inputName,
    dlqName,
    create: async () => {
      const dlq = await client.send(
        new CreateQueueCommand({
          QueueName: dlqName,
          Attributes: {
            FifoQueue: "true",
            ContentBasedDeduplication: "false",
            VisibilityTimeout: "30",
          },
        }),
      );
      dlqUrl = dlq.QueueUrl;

      const { Attributes } = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: requireUrl(dlqUrl),
          AttributeNames: ["QueueArn"],
        }),
      );

      const input = await client.send(
        new CreateQueueCommand({
          QueueName: inputName,
          Attributes: {
            FifoQueue: "true",
            ContentBasedDeduplication: "false",
            VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 3),
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: Attributes?.QueueArn,
              maxReceiveCount: String(MAX_RECEIVE_COUNT),
            }),
          },
        }),
      );
      inputUrl = input.QueueUrl;
    },
    purge: async () => {
      for (const url of [inputUrl, dlqUrl]) {
        if (url) {
          await client.send(new PurgeQueueCommand({ QueueUrl: url }));
        }
      }
    },
    send: async (message, sendOptions = {}) => {
      const body = typeof message === "string" ? message : JSON.stringify(message);
      const parsed =
        typeof message === "object" && message !== null
          ? (message as { messageId?: string; data?: { walletId?: string } })
          : {};

      await client.send(
        new SendMessageCommand({
          QueueUrl: requireUrl(inputUrl),
          MessageBody: body,
          MessageGroupId: sendOptions.groupId ?? parsed.data?.walletId ?? randomUUID(),
          MessageDeduplicationId: sendOptions.deduplicationId ?? parsed.messageId ?? randomUUID(),
        }),
      );
    },
    inputDepth: () => depth(requireUrl(inputUrl)),
    dlqDepth: () => depth(requireUrl(dlqUrl)),
    drainDlq: (expected, timeoutMs = 15_000) =>
      drainDlq(client, requireUrl(dlqUrl), expected, timeoutMs),
    takeFromInput: async (max = 10) => {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: requireUrl(inputUrl),
          MaxNumberOfMessages: max,
          WaitTimeSeconds: 1,
          VisibilityTimeout: 1,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );

      return (response.Messages ?? []).map((message) => ({
        body: message.Body ?? "",
        receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
      }));
    },
    close: async () => {
      for (const url of [inputUrl, dlqUrl]) {
        if (url) {
          await client.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
        }
      }
      client.destroy();
    },
  };

  await queues.create();

  return queues;
}

async function drainDlq(
  client: SQSClient,
  queueUrl: string,
  expected: number | undefined,
  timeoutMs: number,
): Promise<DeadLetter[]> {
  const received: DeadLetter[] = [];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["All"],
      }),
    );
    const messages = response.Messages ?? [];

    if (messages.length === 0) {
      if (expected === undefined || received.length >= expected) {
        break;
      }
      continue;
    }

    await client.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((message, index) => ({
          Id: String(index),
          ReceiptHandle: message.ReceiptHandle as string,
        })),
      }),
    );

    for (const message of messages) {
      const body = message.Body as string;
      received.push({
        body,
        rawBody: safeParse(body),
        groupId: message.Attributes?.MessageGroupId,
        deduplicationId: message.Attributes?.MessageDeduplicationId,
        failureReason: message.MessageAttributes?.failureReason?.StringValue,
      });
    }

    if (expected !== undefined && received.length >= expected) {
      break;
    }
  }

  return received;
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export interface WagerRequestMessage {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export function wagerMessage(
  payload: WagerPayload,
  overrides: {
    messageId?: string;
    type?: string;
    idempotencyKey?: string;
    data?: Record<string, unknown>;
  } = {},
): WagerRequestMessage {
  return {
    messageId: overrides.messageId ?? `msg-${randomUUID()}`,
    type: overrides.type ?? "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      ...payload,
      idempotencyKey:
        overrides.idempotencyKey ?? `${payload.providerId}:${payload.externalTransactionId}`,
      ...overrides.data,
    },
  };
}

export class RecordingQueue implements MessageQueue {
  readonly received: { sqsMessageId: string; receiveCount: number; body: string }[] = [];
  readonly visibilityChanges: { sqsMessageId: string; seconds: number }[] = [];
  readonly deleted: string[] = [];
  readonly deadLettered: string[] = [];
  readonly events: string[] = [];
  failDeadLetter = false;

  constructor(private readonly delegate: MessageQueue) {}

  async receive(options: ReceiveOptions): Promise<QueueMessage[]> {
    const messages = await this.delegate.receive(options);

    for (const message of messages) {
      this.received.push({
        sqsMessageId: message.sqsMessageId,
        receiveCount: message.receiveCount,
        body: message.body,
      });
    }

    return messages;
  }

  async delete(message: QueueMessage): Promise<void> {
    this.events.push(`delete:${message.sqsMessageId}`);
    await this.delegate.delete(message);
    this.deleted.push(message.sqsMessageId);
  }

  async changeVisibility(message: QueueMessage, seconds: number): Promise<void> {
    this.events.push(`visibility:${message.sqsMessageId}:${seconds}`);
    await this.delegate.changeVisibility(message, seconds);
    this.visibilityChanges.push({ sqsMessageId: message.sqsMessageId, seconds });
  }

  async sendToDeadLetter(message: QueueMessage, reason: string): Promise<void> {
    this.events.push(`dlq:${message.sqsMessageId}`);

    if (this.failDeadLetter) {
      throw new Error("SQS recusou o envio para a DLQ");
    }

    await this.delegate.sendToDeadLetter(message, reason);
    this.deadLettered.push(message.sqsMessageId);
  }

  receivesOf(body: (parsed: { messageId?: string }) => boolean): number {
    return this.received.filter((entry) => body(safeParse(entry.body) as { messageId?: string }))
      .length;
  }

  reset(): void {
    this.received.length = 0;
    this.visibilityChanges.length = 0;
    this.deleted.length = 0;
    this.deadLettered.length = 0;
    this.events.length = 0;
    this.failDeadLetter = false;
  }
}

export function recordingQueue(env: Record<string, string>): RecordingQueue {
  const config: AppConfig = testConfig(env);

  return new RecordingQueue(new SqsMessageQueue(newSqsClient(config), config));
}

export const consumerOf = (instance: AppInstance): WagerTransactionConsumer =>
  instance.app.get(WagerTransactionConsumer, { strict: false });

export const CONSUMER_TEST_ENV = {
  CONSUMER_WAIT_SECONDS: "1",
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: "3",
  CONSUMER_BACKOFF_BASE_SECONDS: "1",
  CONSUMER_BACKOFF_MAX_SECONDS: "4",
  CONSUMER_SHUTDOWN_TIMEOUT_MS: "10000",
} as const;
