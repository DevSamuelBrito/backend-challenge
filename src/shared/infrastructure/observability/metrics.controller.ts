import { Controller, Get, Inject, Res } from "@nestjs/common";
import { METRICS } from "../../application/metrics.port";
import type { PromMetrics } from "./prom-metrics";

interface TextResponse {
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
}

@Controller("metrics")
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: PromMetrics) {}

  @Get()
  async scrape(@Res() response: TextResponse): Promise<void> {
    response.setHeader("Content-Type", this.metrics.contentType);
    response.send(await this.metrics.render());
  }
}
