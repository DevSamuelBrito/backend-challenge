import { randomUUID } from "node:crypto";
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Client } from "pg";
import type { AppConfig } from "../../src/config/env";
import type {
  EventPublisher,
  OutboundEvent,
  PublishOutcome,
} from "../../src/modules/messaging/application/event-publisher.port";
import { OutboxPublisher } from "../../src/modules/messaging/application/outbox-publisher";
import { OutboxScheduler } from "../../src/modules/messaging/infrastructure/outbox.scheduler";
import { SqsEventPublisher } from "../../src/modules/messaging/infrastructure/sqs-event-publisher";
import type { FaultInjector, FaultPoint } from "../../src/shared/application/fault-injector.port";
import { testConfig } from "./test-config";
import type { AppInstance } from "./wallet-api";

export interface ReceivedEvent {
  body: {
    eventId: string;
    eventType: string;
    aggregateId: string;
    data: { walletId: string; transactionId?: string };
    [key: string]: unknown;
  };
  rawBody: string;
  groupId: string | undefined;
  deduplicationId: string | undefined;
  attributes: { eventType?: string; eventId?: string };
}

export interface EventsQueue {
  name: string;
  create(): Promise<void>;
  purge(): Promise<void>;
  drain(expected?: number, timeoutMs?: number): Promise<ReceivedEvent[]>;
  close(): Promise<void>;
}

export function newSqsClient(config: AppConfig = testConfig()): SQSClient {
  return new SQSClient({
    region: config.sqs.region,
    endpoint: config.sqs.endpoint,
    credentials: {
      accessKeyId: config.sqs.accessKeyId,
      secretAccessKey: config.sqs.secretAccessKey,
    },
  });
}

export async function createEventsQueue(options: { create?: boolean } = {}): Promise<EventsQueue> {
  const client = newSqsClient();
  const name = `wager-events-test-${randomUUID()}.fifo`;
  let queueUrl: string | undefined;

  const queue: EventsQueue = {
    name,
    create: async () => {
      const { QueueUrl } = await client.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: {
            FifoQueue: "true",
            ContentBasedDeduplication: "false",
            VisibilityTimeout: "60",
          },
        }),
      );

      if (!QueueUrl) {
        throw new Error("LocalStack não devolveu a URL da fila de teste");
      }

      queueUrl = QueueUrl;
    },
    purge: async () => {
      if (queueUrl) {
        await client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
      }
    },
    drain: (expected, timeoutMs = 15_000) => {
      if (!queueUrl) {
        throw new Error("a fila de teste ainda não foi criada");
      }

      return drain(client, queueUrl, expected, timeoutMs);
    },
    close: async () => {
      if (queueUrl) {
        await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
      }
      client.destroy();
    },
  };

  if (options.create ?? true) {
    await queue.create();
  }

  return queue;
}

async function drain(
  client: SQSClient,
  queueUrl: string,
  expected: number | undefined,
  timeoutMs: number,
): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
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
      received.push({
        body: JSON.parse(message.Body as string),
        rawBody: message.Body as string,
        groupId: message.Attributes?.MessageGroupId,
        deduplicationId: message.Attributes?.MessageDeduplicationId,
        attributes: {
          eventType: message.MessageAttributes?.eventType?.StringValue,
          eventId: message.MessageAttributes?.eventId?.StringValue,
        },
      });
    }

    if (expected !== undefined && received.length >= expected) {
      break;
    }
  }

  return received;
}

export class CountingPublisher implements EventPublisher {
  readonly sent: string[] = [];
  gate: Promise<void> | undefined;

  constructor(private readonly delegate: EventPublisher) {}

  async publish(events: readonly OutboundEvent[]): Promise<PublishOutcome[]> {
    for (const event of events) {
      this.sent.push(event.eventId);
    }

    await this.gate;

    return this.delegate.publish(events);
  }

  sendsOf(eventId: string): number {
    return this.sent.filter((id) => id === eventId).length;
  }

  reset(): void {
    this.sent.length = 0;
  }
}

export function countingPublisher(queueName: string): CountingPublisher {
  const config = testConfig({ SQS_EVENTS_QUEUE: queueName });

  return new CountingPublisher(new SqsEventPublisher(newSqsClient(config), config));
}

export class SimulatedCrash extends Error {
  constructor(point: FaultPoint) {
    super(`processo morreu em ${point}`);
    this.name = "SimulatedCrash";
  }
}

export class ScriptedFaultInjector implements FaultInjector {
  private armed = new Set<FaultPoint>();
  readonly reached: FaultPoint[] = [];

  armCrash(point: FaultPoint): void {
    this.armed.add(point);
  }

  disarm(): void {
    this.armed.clear();
  }

  check(point: FaultPoint): void {
    this.reached.push(point);

    if (this.armed.delete(point)) {
      throw new SimulatedCrash(point);
    }
  }
}

export const outboxPublisherOf = (instance: AppInstance): OutboxPublisher =>
  instance.app.get(OutboxPublisher, { strict: false });

export const outboxSchedulerOf = (instance: AppInstance): OutboxScheduler =>
  instance.app.get(OutboxScheduler, { strict: false });

export interface SeedRow {
  walletId?: string | null;
  eventType?: string;
  attempts?: number;
  nextAttemptAt?: Date;
  publishedAt?: Date | null;
  eventId?: string;
}

export const AT = new Date("2031-05-05T10:00:00.000Z");

export async function seedOutbox(client: Client, rows: SeedRow[]): Promise<string[]> {
  const ids: string[] = [];

  for (const row of rows) {
    const eventId = row.eventId ?? randomUUID();
    const walletId = row.walletId === undefined ? randomUUID() : row.walletId;
    const eventType = row.eventType ?? "WalletBalanceChanged";
    const payload = {
      eventId,
      eventType,
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      occurredAt: AT.toISOString(),
      version: 1,
      data: walletId === null ? {} : { walletId, transactionId: randomUUID() },
    };

    await client.query(
      `insert into outbox_messages
         (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        eventId,
        payload.aggregateId,
        eventType,
        JSON.stringify(payload),
        AT,
        row.attempts ?? 0,
        row.nextAttemptAt ?? AT,
        row.publishedAt ?? null,
      ],
    );
    ids.push(eventId);
  }

  return ids;
}

export async function pendingCount(client: Client): Promise<number> {
  const { rows } = await client.query(
    "select count(*)::int as total from outbox_messages where published_at is null",
  );

  return rows[0].total as number;
}

export interface OutboxRow {
  id: string;
  seq: string;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
}

export async function outboxRows(client: Client, ids?: string[]): Promise<OutboxRow[]> {
  const { rows } = await client.query(
    `select id, seq::text as seq, attempts, next_attempt_at, published_at
       from outbox_messages
      ${ids ? "where id = any($1)" : ""}
      order by outbox_messages.seq`,
    ids ? [ids] : [],
  );

  return rows as OutboxRow[];
}
