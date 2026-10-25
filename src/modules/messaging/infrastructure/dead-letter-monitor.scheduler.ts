import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env";
import { describeError } from "../../../shared/application/safe-error";
import { PeriodicRunner } from "../../../shared/infrastructure/scheduling/periodic-runner";
import { DeadLetterMonitor } from "../application/dead-letter-monitor";

export type DeadLetterMonitorSchedulerConfig = Pick<AppConfig, "roles"> & {
  consumer: Pick<AppConfig["consumer"], "dlqMonitorIntervalMs">;
};

@Injectable()
export class DeadLetterMonitorScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeadLetterMonitorScheduler.name);
  private readonly runner: PeriodicRunner;

  constructor(
    @Inject(DeadLetterMonitor) private readonly monitor: Pick<DeadLetterMonitor, "tick">,
    @Inject(APP_CONFIG) private readonly config: DeadLetterMonitorSchedulerConfig,
  ) {
    this.runner = new PeriodicRunner(
      () => this.monitor.tick(),
      config.consumer.dlqMonitorIntervalMs,
      (error) => this.logger.error({ event: "dlq.tick_failed", error: describeError(error) }),
    );
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
    this.runner.start();
    void this.monitor.tick();
  }

  stop(): Promise<void> {
    return this.runner.stop();
  }
}
