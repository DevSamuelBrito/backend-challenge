import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env";
import { CLOCK, type Clock } from "../../../shared/application/clock.port";
import { describeError } from "../../../shared/application/safe-error";
import { PeriodicRunner } from "../../../shared/infrastructure/scheduling/periodic-runner";
import { OutboxPublisher } from "../application/outbox-publisher";

export type OutboxSchedulerConfig = Pick<AppConfig, "roles"> & {
  outbox: Pick<AppConfig["outbox"], "tickIntervalMs">;
};

@Injectable()
export class OutboxScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxScheduler.name);
  private readonly runner: PeriodicRunner;

  constructor(
    @Inject(OutboxPublisher) private readonly publisher: Pick<OutboxPublisher, "tick">,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: OutboxSchedulerConfig,
  ) {
    this.runner = new PeriodicRunner(
      async () => {
        await this.publisher.tick(this.clock.now());
      },
      config.outbox.tickIntervalMs,
      (error) => this.logger.error({ event: "outbox.tick_failed", error: describeError(error) }),
    );
  }

  onModuleInit(): void {
    if (this.config.roles.includes("outbox")) {
      this.start();
    }
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  start(): void {
    this.runner.start();
  }

  stop(): Promise<void> {
    return this.runner.stop();
  }
}
