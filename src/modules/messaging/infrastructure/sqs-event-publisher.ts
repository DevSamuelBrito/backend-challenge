import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env";
import { SQS_CLIENT } from "../../../shared/infrastructure/sqs/sqs.module";
import type {
  EventPublisher,
  OutboundEvent,
  PublishOutcome,
} from "../application/event-publisher.port";

const SQS_BATCH_LIMIT = 10;

export type SqsPublisherConfig = Pick<AppConfig, "outbox"> & {
  sqs: Pick<AppConfig["sqs"], "eventsQueue">;
};

@Injectable()
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(APP_CONFIG) private readonly config: SqsPublisherConfig,
  ) {}

  async publish(events: readonly OutboundEvent[]): Promise<PublishOutcome[]> {
    let queueUrl: string;

    try {
      queueUrl = await this.resolveQueueUrl();
    } catch (error) {
      return events.map((event) => unconfirmed(event, describe(error)));
    }

    const outcomes: PublishOutcome[] = [];

    for (let start = 0; start < events.length; start += SQS_BATCH_LIMIT) {
      const chunk = events.slice(start, start + SQS_BATCH_LIMIT);

      try {
        outcomes.push(...(await this.sendChunk(queueUrl, chunk)));
      } catch (error) {
        const reason = describe(error);
        outcomes.push(...events.slice(start).map((event) => unconfirmed(event, reason)));
        break;
      }
    }

    return outcomes;
  }

  private async resolveQueueUrl(): Promise<string> {
    if (this.queueUrl !== undefined) {
      return this.queueUrl;
    }

    const { QueueUrl } = await this.client.send(
      new GetQueueUrlCommand({ QueueName: this.config.sqs.eventsQueue }),
      { abortSignal: AbortSignal.timeout(this.config.outbox.sendTimeoutMs) },
    );

    if (!QueueUrl) {
      throw new Error(`Fila ${this.config.sqs.eventsQueue} sem URL`);
    }

    this.queueUrl = QueueUrl;

    return QueueUrl;
  }

  private async sendChunk(
    queueUrl: string,
    chunk: readonly OutboundEvent[],
  ): Promise<PublishOutcome[]> {
    const response = await this.client.send(
      new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: chunk.map(toEntry) }),
      { abortSignal: AbortSignal.timeout(this.config.outbox.sendTimeoutMs) },
    );

    const confirmed = new Set((response.Successful ?? []).map((entry) => entry.Id));
    const failures = new Map(
      (response.Failed ?? []).map((entry) => [entry.Id, `${entry.Code}: ${entry.Message}`]),
    );

    return chunk.map((event) =>
      confirmed.has(event.eventId)
        ? { eventId: event.eventId, confirmed: true }
        : unconfirmed(event, failures.get(event.eventId) ?? "entrada ausente na resposta do SQS"),
    );
  }
}

function toEntry(event: OutboundEvent): SendMessageBatchRequestEntry {
  return {
    Id: event.eventId,
    MessageBody: event.body,
    MessageGroupId: event.groupId,
    MessageDeduplicationId: event.eventId,
    MessageAttributes: {
      eventType: { DataType: "String", StringValue: event.eventType },
      eventId: { DataType: "String", StringValue: event.eventId },
    },
  };
}

function unconfirmed(event: OutboundEvent, reason: string): PublishOutcome {
  return { eventId: event.eventId, confirmed: false, reason };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
