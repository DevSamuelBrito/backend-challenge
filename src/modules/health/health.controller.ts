import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ReadinessService } from "./readiness.service";

@Controller("health")
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ok"; checks: Record<string, string> }> {
    const report = await this.readiness.check();

    if (!report.ready) {
      throw new ServiceUnavailableException({ status: "unavailable", checks: report.checks });
    }

    return { status: "ok", checks: report.checks };
  }
}
