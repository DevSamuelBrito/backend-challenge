import type { SQL } from "bun";
import { type Instance, scrapeAll } from "./cluster";
import { delay } from "./engine";
import { maxMetric } from "./prometheus";

const SAMPLE_INTERVAL_MS = 500;
const POLL_INTERVAL_MS = 250;

export class OutboxLagSampler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  peakLagSeconds = 0;

  constructor(private readonly instances: readonly Instance[]) {}

  start(): void {
    this.peakLagSeconds = 0;
    this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async sample(): Promise<void> {
    if (this.busy) {
      return;
    }

    this.busy = true;

    try {
      const lag = maxMetric(await scrapeAll(this.instances), "wager_outbox_lag_seconds");
      this.peakLagSeconds = Math.max(this.peakLagSeconds, lag);
    } catch {
      // a amostra perdida só afeta o pico observado
    } finally {
      this.busy = false;
    }
  }
}

export async function unpublishedOutbox(sql: SQL): Promise<number> {
  const rows =
    (await sql`select count(*)::int as n from outbox_messages where published_at is null`) as {
      n: number;
    }[];

  return rows[0]?.n ?? 0;
}

export interface DrainResult {
  drained: boolean;
  seconds: number;
}

export async function waitForOutboxDrain(
  sql: SQL,
  startedAt: number,
  timeoutSeconds: number,
): Promise<DrainResult> {
  const deadline = startedAt + timeoutSeconds * 1000;

  while (true) {
    if ((await unpublishedOutbox(sql)) === 0) {
      return { drained: true, seconds: (performance.now() - startedAt) / 1000 };
    }

    if (performance.now() > deadline) {
      return { drained: false, seconds: (performance.now() - startedAt) / 1000 };
    }

    await delay(POLL_INTERVAL_MS);
  }
}
