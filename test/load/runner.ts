import type { SQL } from "bun";
import { classify, LoadClient, type Sample } from "./client";
import { type Instance, scrapeAll } from "./cluster";
import { runClosedLoop } from "./engine";
import { OutboxLagSampler, unpublishedOutbox, waitForOutboxDrain } from "./outbox";
import {
  histogramDelta,
  histogramOf,
  histogramQuantile,
  type MetricSample,
  sumMetric,
} from "./prometheus";
import { SCENARIOS, type Scenario } from "./scenarios";
import type { LoadSettings } from "./settings";
import { type LatencySummary, summarizeLatency } from "./stats";
import { type Check, type PendingStats, verifyCorrectness } from "./verify";

export interface ScenarioResult {
  id: string;
  title: string;
  round: number;
  concurrency: number;
  requests: number;
  durationMs: number;
  throughput: number;
  latency: LatencySummary;
  statusCounts: Record<string, number>;
  technicalErrors: number;
  technicalErrorRate: number;
  businessRejections: number;
  conflicts: number;
  pending202: number;
  lock: {
    timeouts: number;
    acquisitions: number;
    meanWaitMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  server: { count: number; p50Ms: number; p95Ms: number; p99Ms: number };
  outbox: {
    peakLagSeconds: number;
    backlogAtLoadEnd: number;
    drainSeconds: number;
    drained: boolean;
  };
  pending: PendingStats | null;
  checks: Check[];
  notes: string[];
}

export interface RunContext {
  instances: readonly Instance[];
  sql: SQL;
  settings: LoadSettings;
  runId: string;
}

const toMs = (seconds: number) => seconds * 1000;

function summarizeSamples(samples: readonly Sample[]) {
  const statusCounts: Record<string, number> = {};
  let technicalErrors = 0;
  let businessRejections = 0;
  let conflicts = 0;
  let pending202 = 0;

  for (const sample of samples) {
    const key = sample.status === 0 ? "timeout/rede" : String(sample.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;

    switch (classify(sample.status)) {
      case "network":
      case "server_error":
      case "lock_timeout":
        technicalErrors += 1;
        break;
      case "business":
        businessRejections += 1;
        break;
      case "conflict":
        conflicts += 1;
        break;
      case "pending":
        pending202 += 1;
        break;
      default:
        break;
    }
  }

  return { statusCounts, technicalErrors, businessRejections, conflicts, pending202 };
}

function lockStats(before: MetricSample[], after: MetricSample[]) {
  const wait = histogramDelta(
    histogramOf(after, "wager_wallet_lock_wait_seconds"),
    histogramOf(before, "wager_wallet_lock_wait_seconds"),
  );

  return {
    timeouts:
      sumMetric(after, "wager_lock_timeouts_total") -
      sumMetric(before, "wager_lock_timeouts_total"),
    acquisitions: wait.count,
    meanWaitMs: wait.count > 0 ? toMs(wait.sum / wait.count) : Number.NaN,
    p50Ms: toMs(histogramQuantile(wait, 0.5)),
    p95Ms: toMs(histogramQuantile(wait, 0.95)),
    p99Ms: toMs(histogramQuantile(wait, 0.99)),
  };
}

function serverStats(before: MetricSample[], after: MetricSample[]) {
  const filter = { source: "http" };
  const processing = histogramDelta(
    histogramOf(after, "wager_processing_duration_seconds", filter),
    histogramOf(before, "wager_processing_duration_seconds", filter),
  );

  return {
    count: processing.count,
    p50Ms: toMs(histogramQuantile(processing, 0.5)),
    p95Ms: toMs(histogramQuantile(processing, 0.95)),
    p99Ms: toMs(histogramQuantile(processing, 0.99)),
  };
}

async function warmup(context: RunContext, client: LoadClient, round: number): Promise<void> {
  if (context.settings.warmupRequests === 0) {
    return;
  }

  const wallets = await Promise.all(
    [0, 1, 2].map(async (index) => ({
      id: await client.createWallet(`load-${context.runId}-r${round}-warmup-${index}`, "100000.00"),
      playerId: `load-${context.runId}-r${round}-warmup-${index}`,
    })),
  );
  const requests = Array.from({ length: context.settings.warmupRequests }, (_, index) => index);

  await runClosedLoop(context.settings.concurrency, requests, async (index) => {
    const wallet = wallets[index % wallets.length] as { id: string; playerId: string };
    const external = `${context.runId}-r${round}-warmup-${index}`;

    await client.transaction("warmup", {
      providerId: "load",
      externalTransactionId: external,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `${external}-round`,
      gameId: "load-game",
      kind: "BET",
      money: { amount: "1.00", currency: "BRL" },
    });
  });
}

async function runScenario(
  context: RunContext,
  client: LoadClient,
  scenario: Scenario,
  round: number,
): Promise<ScenarioResult> {
  const scenarioContext = { client, settings: context.settings, runId: context.runId, round };
  const prepared = await scenario.prepare(scenarioContext);

  const settled = await waitForOutboxDrain(
    context.sql,
    performance.now(),
    context.settings.drainTimeoutSeconds,
  );

  if (!settled.drained) {
    throw new Error(
      `a outbox não drenou antes do cenário ${scenario.id}; reexecute depois de ela esvaziar`,
    );
  }

  const before = await scrapeAll(context.instances);
  const sampler = new OutboxLagSampler(context.instances);
  sampler.start();

  try {
    const execution = await scenario.execute(scenarioContext, prepared);
    const loadEndedAt = performance.now();
    const after = await scrapeAll(context.instances);
    const backlogAtLoadEnd = await unpublishedOutbox(context.sql);
    const verification = await verifyCorrectness(
      { sql: context.sql, client, settings: context.settings },
      execution,
      loadEndedAt,
    );
    const summary = summarizeSamples(execution.samples);
    const requests = execution.samples.length;

    return {
      id: scenario.id,
      title: scenario.title,
      round,
      concurrency: execution.concurrency,
      requests,
      durationMs: execution.durationMs,
      throughput: requests / (execution.durationMs / 1000),
      latency: summarizeLatency(execution.samples.map((sample) => sample.ms)),
      ...summary,
      technicalErrorRate: summary.technicalErrors / requests,
      lock: lockStats(before, after),
      server: serverStats(before, after),
      outbox: {
        peakLagSeconds: sampler.peakLagSeconds,
        backlogAtLoadEnd,
        drainSeconds: verification.drain.seconds,
        drained: verification.drain.drained,
      },
      pending: verification.pending,
      checks: verification.checks,
      notes: execution.notes,
    };
  } finally {
    sampler.stop();
  }
}

export async function runRound(
  context: RunContext,
  round: number,
  results: ScenarioResult[],
): Promise<void> {
  const client = new LoadClient(context.instances, context.settings.requestTimeoutMs);

  console.log(`\n=== Rodada ${round}/${context.settings.rounds} ===`);
  await warmup(context, client, round);
  console.log("aquecimento concluído (descartado das medições)");

  for (const scenario of SCENARIOS) {
    const result = await runScenario(context, client, scenario, round);
    const failed = result.checks.filter((entry) => !entry.ok);

    console.log(
      `${failed.length === 0 ? "OK    " : "FALHOU"} ${scenario.title}: ${result.requests} req em ` +
        `${(result.durationMs / 1000).toFixed(1)}s, ${result.throughput.toFixed(0)} req/s, ` +
        `p50 ${result.latency.p50.toFixed(0)} ms, p99 ${result.latency.p99.toFixed(0)} ms, ` +
        `erros técnicos ${result.technicalErrors}, outbox drenou em ${result.outbox.drainSeconds.toFixed(1)}s`,
    );

    for (const entry of failed) {
      console.log(`       falhou: ${entry.name} -> ${entry.detail}`);
    }

    results.push(result);
  }
}
