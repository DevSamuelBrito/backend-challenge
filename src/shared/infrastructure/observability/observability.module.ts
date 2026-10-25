import {
  Global,
  Inject,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnModuleDestroy,
  RequestMethod,
} from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env";
import { METRICS } from "../../application/metrics.port";
import { SystemModule } from "../system/system.module";
import { CorrelationMiddleware } from "./correlation.middleware";
import { MetricsController } from "./metrics.controller";
import { createPino, LOG_DESTINATION, PinoLoggerService } from "./pino-logger";
import { PromMetrics } from "./prom-metrics";

@Global()
@Module({
  imports: [SystemModule],
  controllers: [MetricsController],
  providers: [
    CorrelationMiddleware,
    { provide: LOG_DESTINATION, useValue: undefined },
    {
      provide: METRICS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new PromMetrics({ defaultMetrics: config.observability.defaultMetrics }),
    },
    {
      provide: PinoLoggerService,
      inject: [APP_CONFIG, LOG_DESTINATION],
      useFactory: (config: AppConfig, destination: NodeJS.WritableStream | undefined) =>
        new PinoLoggerService(createPino(config.observability.logLevel, destination)),
    },
  ],
  exports: [METRICS, PinoLoggerService],
})
export class ObservabilityModule implements NestModule, OnModuleDestroy {
  constructor(@Inject(METRICS) private readonly metrics: PromMetrics) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationMiddleware)
      .forRoutes({ path: "/{*splat}", method: RequestMethod.ALL });
  }

  onModuleDestroy(): void {
    this.metrics.registry.clear();
  }
}
