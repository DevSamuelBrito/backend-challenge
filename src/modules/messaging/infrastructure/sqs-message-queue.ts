import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env";
import { SQS_CLIENT } from "../../../shared/infrastructure/sqs/sqs.module";
import type { MessageQueue, QueueMessage, ReceiveOptions } from "../application/message-queue.port";

export type SqsMessageQueueConfig = Pick<AppConfig, "consumer"> & {
  sqs: Pick<AppConfig["sqs"], "transactionsQueue" | "transactionsDlq">;
};

@Injectable()
export class SqsMessageQueue implements MessageQueue {
  private readonly urls = new Map<string, string>();

  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(APP_CONFIG) private readonly config: SqsMessageQueueConfig,
  ) {}

  async receive(options: ReceiveOptions): Promise<QueueMessage[]> {
    const queueUrl = await this.urlOf(this.config.sqs.transactionsQueue);

    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitSeconds,
        VisibilityTimeout: options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: [
          "ApproximateReceiveCount",
          "MessageGroupId",
          "MessageDeduplicationId",
        ],
      }),
      {
        abortSignal: AbortSignal.timeout(
          options.waitSeconds * 1000 + this.config.consumer.sdkTimeoutMs,
        ),
      },
    );

    return (response.Messages ?? []).map((message) => ({
      sqsMessageId: message.MessageId as string,
      receiptHandle: message.ReceiptHandle as string,
      body: message.Body ?? "",
      groupId: message.Attributes?.MessageGroupId,
      deduplicationId: message.Attributes?.MessageDeduplicationId,
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
    }));
  }

  async delete(message: QueueMessage): Promise<void> {
    const queueUrl = await this.urlOf(this.config.sqs.transactionsQueue);

    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.receiptHandle }),
      { abortSignal: this.shortTimeout() },
    );
  }

  async changeVisibility(message: QueueMessage, seconds: number): Promise<void> {
    const queueUrl = await this.urlOf(this.config.sqs.transactionsQueue);

    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
      { abortSignal: this.shortTimeout() },
    );
  }

  async sendToDeadLetter(message: QueueMessage, reason: string): Promise<void> {
    const queueUrl = await this.urlOf(this.config.sqs.transactionsDlq);

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: message.body,
        MessageGroupId: message.groupId ?? message.sqsMessageId,
        MessageDeduplicationId: message.deduplicationId ?? message.sqsMessageId,
        MessageAttributes: {
          failureReason: { DataType: "String", StringValue: reason },
          sourceQueue: { DataType: "String", StringValue: this.config.sqs.transactionsQueue },
          originalSqsMessageId: { DataType: "String", StringValue: message.sqsMessageId },
        },
      }),
      { abortSignal: this.shortTimeout() },
    );
  }

  private shortTimeout(): AbortSignal {
    return AbortSignal.timeout(this.config.consumer.sdkTimeoutMs);
  }

  private async urlOf(queueName: string): Promise<string> {
    const cached = this.urls.get(queueName);

    if (cached !== undefined) {
      return cached;
    }

    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }), {
      abortSignal: this.shortTimeout(),
    });

    if (!QueueUrl) {
      throw new Error(`Fila ${queueName} sem URL`);
    }

    this.urls.set(queueName, QueueUrl);

    return QueueUrl;
  }
}
