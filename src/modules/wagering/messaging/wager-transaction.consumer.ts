import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env";
import {
  FAULT_INJECTOR,
  type FaultInjector,
} from "../../../shared/application/fault-injector.port";
import { MESSAGE_QUEUE, type MessageQueue } from "../../messaging/application/message-queue.port";
import { QueueConsumer } from "../../messaging/application/queue-consumer";
import { WagerTransactionMessageHandler } from "./wager-transaction-message.handler";

export type WagerTransactionConsumerConfig = Pick<AppConfig, "roles" | "consumer">;

const POLL_FAILURE_PAUSE_MS = 1000;

@Injectable()
export class WagerTransactionConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly consumer: QueueConsumer;

  constructor(
    @Inject(MESSAGE_QUEUE) queue: MessageQueue,
    handler: WagerTransactionMessageHandler,
    @Inject(FAULT_INJECTOR) faults: FaultInjector,
    @Inject(APP_CONFIG) private readonly config: WagerTransactionConsumerConfig,
  ) {
    const { consumer } = config;

    this.consumer = new QueueConsumer(queue, handler, faults, {
      waitSeconds: consumer.waitSeconds,
      batchSize: consumer.batchSize,
      concurrency: consumer.concurrency,
      visibilityTimeoutSeconds: consumer.visibilityTimeoutSeconds,
      backoff: { baseSeconds: consumer.backoffBaseSeconds, maxSeconds: consumer.backoffMaxSeconds },
      shutdownTimeoutMs: consumer.shutdownTimeoutMs,
      pollFailurePauseMs: POLL_FAILURE_PAUSE_MS,
    });
  }

  onModuleInit(): void {
    if (this.config.roles.includes("consumer")) {
      this.start();
    }
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  start(): void {
    this.consumer.start();
  }

  stop(): Promise<void> {
    return this.consumer.stop();
  }
}
