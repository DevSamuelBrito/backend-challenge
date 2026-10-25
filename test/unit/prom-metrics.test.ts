import { describe, expect, test } from "bun:test";
import { PromMetrics } from "../../src/shared/infrastructure/observability/prom-metrics";
import { ALL_METRIC_NAMES, metricValue } from "../support/observability";

describe("PromMetrics", () => {
  const build = (defaultMetrics = false) => new PromMetrics({ defaultMetrics });

  test("expõe todas as métricas do enunciado, mesmo antes de qualquer evento", async () => {
    const text = await build().render();

    for (const name of ALL_METRIC_NAMES) {
      expect(text).toContain(`# TYPE ${name} `);
    }
  });

  test("os tipos são counter, gauge e histogram conforme o caso", async () => {
    const text = await build().render();

    expect(text).toContain("# TYPE wager_transactions_total counter");
    expect(text).toContain("# TYPE wager_outbox_lag_seconds gauge");
    expect(text).toContain("# TYPE wager_dlq_messages gauge");
    expect(text).toContain("# TYPE wager_wallet_lock_wait_seconds histogram");
    expect(text).toContain("# TYPE wager_processing_duration_seconds histogram");
  });

  test("os contadores usam labels de baixa cardinalidade", async () => {
    const metrics = build();

    metrics.transactionRecorded("BET", "PROCESSED");
    metrics.transactionRecorded("BET", "PROCESSED");
    metrics.transactionRecorded("WIN", "REJECTED");
    metrics.duplicateDetected("idempotent_replay", "http");
    metrics.duplicateDetected("inbox_message", "sqs");
    metrics.retryScheduled("outbox");
    metrics.deadLettered("MALFORMED_MESSAGE");
    metrics.lockTimeout();
    metrics.reconciliationMismatch();

    const text = await metrics.render();
    expect(
      metricValue(text, "wager_transactions_total", { kind: "BET", status: "PROCESSED" }),
    ).toBe(2);
    expect(metricValue(text, "wager_transactions_total", { kind: "WIN", status: "REJECTED" })).toBe(
      1,
    );
    expect(
      metricValue(text, "wager_duplicates_total", { type: "idempotent_replay", source: "http" }),
    ).toBe(1);
    expect(
      metricValue(text, "wager_duplicates_total", { type: "inbox_message", source: "sqs" }),
    ).toBe(1);
    expect(metricValue(text, "wager_retries_total", { source: "outbox" })).toBe(1);
    expect(metricValue(text, "wager_dead_letter_total", { reason: "MALFORMED_MESSAGE" })).toBe(1);
    expect(metricValue(text, "wager_lock_timeouts_total")).toBe(1);
    expect(metricValue(text, "wager_reconciliation_mismatches_total")).toBe(1);
    expect(text).not.toMatch(/walletId|transactionId|playerId/);
  });

  test("o gauge do outbox lag guarda o último valor", async () => {
    const metrics = build();

    metrics.outboxLag(42.5);
    expect(metricValue(await metrics.render(), "wager_outbox_lag_seconds")).toBe(42.5);

    metrics.outboxLag(0);
    expect(metricValue(await metrics.render(), "wager_outbox_lag_seconds")).toBe(0);
  });

  test("o gauge da DLQ guarda o último valor lido", async () => {
    const metrics = build();

    metrics.deadLetterQueueSize(5);
    expect(metricValue(await metrics.render(), "wager_dlq_messages")).toBe(5);

    metrics.deadLetterQueueSize(0);
    expect(metricValue(await metrics.render(), "wager_dlq_messages")).toBe(0);
  });

  test("os histogramas contam e somam as observações, por origem", async () => {
    const metrics = build();

    metrics.processingDuration("http", 0.02);
    metrics.processingDuration("http", 0.3);
    metrics.processingDuration("sqs", 0.01);
    metrics.walletLockWaited(0.5);

    const text = await metrics.render();
    expect(metricValue(text, "wager_processing_duration_seconds_count", { source: "http" })).toBe(
      2,
    );
    expect(metricValue(text, "wager_processing_duration_seconds_count", { source: "sqs" })).toBe(1);
    expect(metricValue(text, "wager_processing_duration_seconds_count", { source: "worker" })).toBe(
      0,
    );
    expect(
      metricValue(text, "wager_processing_duration_seconds_sum", { source: "http" }),
    ).toBeCloseTo(0.32, 5);
    expect(metricValue(text, "wager_wallet_lock_wait_seconds_count")).toBe(1);
  });

  test("cada instância tem o seu registro: um não enxerga o outro", async () => {
    const first = build();
    const second = build();

    first.lockTimeout();

    expect(metricValue(await first.render(), "wager_lock_timeouts_total")).toBe(1);
    expect(metricValue(await second.render(), "wager_lock_timeouts_total")).toBe(0);
  });

  test("as métricas default do processo só aparecem quando ligadas", async () => {
    expect(await build(false).render()).not.toContain("process_cpu_user_seconds_total");
    expect(await build(true).render()).toContain("process_cpu_user_seconds_total");
  });

  test("o content type é o do formato Prometheus", () => {
    expect(build().contentType).toContain("text/plain");
  });
});
