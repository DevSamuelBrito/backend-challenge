import { Inject, Injectable, Logger } from "@nestjs/common";
import { HEALTH_INDICATORS, type HealthIndicator } from "./health-indicator";

export type DependencyStatus = "up" | "down";

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, DependencyStatus>;
}

function describeFailure(reason: unknown): string {
  if (reason instanceof AggregateError) {
    return reason.errors.map(describeFailure).join("; ");
  }

  if (reason instanceof Error) {
    const code = (reason as { code?: string }).code;
    return code ? `${code} ${reason.message}`.trim() : reason.message || reason.name;
  }

  return String(reason);
}

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(@Inject(HEALTH_INDICATORS) private readonly indicators: HealthIndicator[]) {}

  async check(): Promise<ReadinessReport> {
    const results = await Promise.allSettled(this.indicators.map((indicator) => indicator.check()));

    const checks: Record<string, DependencyStatus> = {};

    results.forEach((result, index) => {
      const indicator = this.indicators[index] as HealthIndicator;

      if (result.status === "rejected") {
        this.logger.warn(`${indicator.name} indisponível: ${describeFailure(result.reason)}`);
      }

      checks[indicator.name] = result.status === "fulfilled" ? "up" : "down";
    });

    return { ready: Object.values(checks).every((status) => status === "up"), checks };
  }
}
