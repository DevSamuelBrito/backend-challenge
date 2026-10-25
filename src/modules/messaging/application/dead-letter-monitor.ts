import { Inject, Injectable, Logger } from "@nestjs/common";
import { METRICS, type Metrics, NO_OP_METRICS } from "../../../shared/application/metrics.port";
import { describeError } from "../../../shared/application/safe-error";
import { MESSAGE_QUEUE, type MessageQueue } from "./message-queue.port";

@Injectable()
export class DeadLetterMonitor {
  private readonly logger = new Logger(DeadLetterMonitor.name);

  constructor(
    @Inject(MESSAGE_QUEUE) private readonly queue: Pick<MessageQueue, "deadLetterDepth">,
    @Inject(METRICS) private readonly metrics: Metrics = NO_OP_METRICS,
  ) {}

  async tick(): Promise<void> {
    try {
      this.metrics.deadLetterQueueSize(await this.queue.deadLetterDepth());
    } catch (error) {
      this.logger.warn({ event: "dlq.monitor_failed", error: describeError(error) });
    }
  }
}
