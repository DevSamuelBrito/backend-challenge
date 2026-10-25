import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Logger } from "@nestjs/common";
import type { AppRole } from "../../src/config/env";
import { DeadLetterMonitor } from "../../src/modules/messaging/application/dead-letter-monitor";
import { DeadLetterMonitorScheduler } from "../../src/modules/messaging/infrastructure/dead-letter-monitor.scheduler";
import { NO_OP_METRICS } from "../../src/shared/application/metrics.port";
import { waitUntil } from "../support/async";

const metricsRecorder = () => {
  const sizes: number[] = [];

  return {
    sizes,
    metrics: { ...NO_OP_METRICS, deadLetterQueueSize: (n: number) => sizes.push(n) },
  };
};

describe("DeadLetterMonitor", () => {
  const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

  afterEach(() => {
    warn.mockClear();
  });

  test("publica o tamanho da DLQ no gauge", async () => {
    const { sizes, metrics } = metricsRecorder();

    await new DeadLetterMonitor({ deadLetterDepth: async () => 7 }, metrics).tick();

    expect(sizes).toEqual([7]);
  });

  test("falha na consulta só loga e mantém o último valor", async () => {
    const { sizes, metrics } = metricsRecorder();
    let depth: () => Promise<number> = async () => 3;
    const monitor = new DeadLetterMonitor({ deadLetterDepth: () => depth() }, metrics);

    await monitor.tick();
    depth = async () => {
      throw Object.assign(new Error("SQS fora do ar com dados sensíveis"), {
        name: "TimeoutError",
      });
    };
    await monitor.tick();

    expect(sizes).toEqual([3]);
    expect(warn).toHaveBeenCalledTimes(1);
    const [logged] = warn.mock.calls[0] as [{ event: string; error: string }];
    expect(logged.event).toBe("dlq.monitor_failed");
    expect(logged.error).not.toContain("sensíveis");
  });
});

describe("DeadLetterMonitorScheduler", () => {
  const build = (roles: AppRole[]) => {
    const calls: number[] = [];
    const scheduler = new DeadLetterMonitorScheduler(
      {
        tick: async () => {
          calls.push(calls.length);
        },
      },
      { roles, consumer: { dlqMonitorIntervalMs: 2 } },
    );

    return { calls, scheduler };
  };

  test("não liga sem o papel consumer", async () => {
    const { calls, scheduler } = build(["api", "outbox"]);

    scheduler.onModuleInit();
    await scheduler.stop();

    expect(calls).toHaveLength(0);
  });

  test("com o papel consumer lê na hora e repete a cada intervalo", async () => {
    const { calls, scheduler } = build(["consumer"]);

    scheduler.onModuleInit();
    await waitUntil(() => calls.length >= 3, "3 leituras");
    await scheduler.stop();
    const stoppedAt = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.length).toBe(stoppedAt);
  });
});
