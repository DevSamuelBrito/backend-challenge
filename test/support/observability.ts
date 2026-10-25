import { Writable } from "node:stream";
import { LOG_DESTINATION } from "../../src/shared/infrastructure/observability/pino-logger";
import type { HttpClient } from "./http";

export type LogLine = Record<string, unknown> & { level: string; msg?: string };

export class LogCapture extends Writable {
  private buffer = "";
  readonly lines: LogLine[] = [];
  readonly raw: string[] = [];

  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.buffer += chunk.toString();
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (part.trim() === "") continue;
      this.raw.push(part);
      this.lines.push(JSON.parse(part) as LogLine);
    }

    done();
  }

  events(name: string): LogLine[] {
    return this.lines.filter((line) => line.event === name);
  }

  clear(): void {
    this.lines.length = 0;
    this.raw.length = 0;
  }
}

export const logProvider = (capture: LogCapture) => ({ token: LOG_DESTINATION, value: capture });

export async function scrape(http: HttpClient): Promise<string> {
  const result = await http.get("/metrics");

  if (result.status !== 200 || typeof result.body !== "string") {
    throw new Error(`/metrics respondeu ${result.status}`);
  }

  return result.body;
}

export function metricValue(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number {
  let total = 0;
  let found = false;

  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.startsWith(name)) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)$/.exec(line);

    if (!match || match[1] !== name) continue;

    const present = new Map<string, string>();
    for (const pair of (match[3] ?? "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
      present.set(pair[1] as string, pair[2] as string);
    }

    if (Object.entries(labels).every(([key, value]) => present.get(key) === value)) {
      total += Number(match[4]);
      found = true;
    }
  }

  return found ? total : 0;
}

export const ALL_METRIC_NAMES = [
  "wager_transactions_total",
  "wager_duplicates_total",
  "wager_retries_total",
  "wager_dead_letter_total",
  "wager_lock_timeouts_total",
  "wager_wallet_lock_wait_seconds",
  "wager_outbox_lag_seconds",
  "wager_processing_duration_seconds",
  "wager_reconciliation_mismatches_total",
] as const;
