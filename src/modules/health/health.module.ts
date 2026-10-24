import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { HEALTH_INDICATORS } from "./health-indicator";
import { PostgresIndicator } from "./postgres.indicator";
import { ReadinessService } from "./readiness.service";
import { SqsIndicator } from "./sqs.indicator";

@Module({
  controllers: [HealthController],
  providers: [
    PostgresIndicator,
    SqsIndicator,
    {
      provide: HEALTH_INDICATORS,
      inject: [PostgresIndicator, SqsIndicator],
      useFactory: (postgres: PostgresIndicator, sqs: SqsIndicator) => [postgres, sqs],
    },
    ReadinessService,
  ],
})
export class HealthModule {}
