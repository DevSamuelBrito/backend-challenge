import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env";
import { SQS_CLIENT } from "../../shared/infrastructure/sqs/sqs.module";
import type { HealthIndicator } from "./health-indicator";
import { withTimeout } from "./with-timeout";

const TIMEOUT_MS = 2000;

@Injectable()
export class SqsIndicator implements HealthIndicator {
  readonly name = "sqs";

  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(): Promise<void> {
    const abortSignal = AbortSignal.timeout(TIMEOUT_MS);

    await withTimeout(this.ping(abortSignal), TIMEOUT_MS, this.name);
  }

  private async ping(abortSignal: AbortSignal): Promise<void> {
    const { QueueUrl } = await this.client.send(
      new GetQueueUrlCommand({ QueueName: this.config.sqs.transactionsQueue }),
      { abortSignal },
    );

    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }),
      { abortSignal },
    );
  }
}
