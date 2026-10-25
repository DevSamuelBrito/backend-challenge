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
import { PendingReferenceWorker } from "../application/pending-reference-worker";

export type SchedulerConfig = Pick<AppConfig, "roles"> & {
  pendingReference: Pick<AppConfig["pendingReference"], "tickIntervalMs">;
};

@Injectable()
export class PendingReferenceScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceScheduler.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    @Inject(PendingReferenceWorker) private readonly worker: Pick<PendingReferenceWorker, "tick">,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: SchedulerConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.roles.includes("pending-worker")) {
      this.start();
    }
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.arm();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;

    await this.running;
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.runOnce().finally(() => {
        this.running = undefined;

        if (!this.stopped) {
          this.arm();
        }
      });
    }, this.config.pendingReference.tickIntervalMs);
  }

  private async runOnce(): Promise<void> {
    try {
      await this.worker.tick(this.clock.now());
    } catch (error) {
      this.logger.error(
        `Falha no tick do worker de PENDING_REFERENCE: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
