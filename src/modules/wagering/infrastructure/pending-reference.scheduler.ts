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
import { PeriodicRunner } from "../../../shared/infrastructure/scheduling/periodic-runner";
import { PendingReferenceWorker } from "../application/pending-reference-worker";

export type SchedulerConfig = Pick<AppConfig, "roles"> & {
  pendingReference: Pick<AppConfig["pendingReference"], "tickIntervalMs">;
};

@Injectable()
export class PendingReferenceScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceScheduler.name);
  private readonly runner: PeriodicRunner;

  constructor(
    @Inject(PendingReferenceWorker) private readonly worker: Pick<PendingReferenceWorker, "tick">,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: SchedulerConfig,
  ) {
    this.runner = new PeriodicRunner(
      async () => {
        await this.worker.tick(this.clock.now());
      },
      config.pendingReference.tickIntervalMs,
      (error) =>
        this.logger.error(
          `Falha no tick do worker de PENDING_REFERENCE: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  onModuleInit(): void {
    if (this.config.roles.includes("pending-worker")) {
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
