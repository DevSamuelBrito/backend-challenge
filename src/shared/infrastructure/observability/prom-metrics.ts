import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";
import type {
  DuplicateType,
  Metrics,
  ProcessingSource,
  RetrySource,
} from "../../application/metrics.port";

const SECONDS_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class PromMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Transações que entraram em um status, por kind e status",
    labelNames: ["kind", "status"],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: "wager_duplicates_total",
    help: "Duplicatas detectadas: replays de idempotência e mensagens já vistas no inbox",
    labelNames: ["type", "source"],
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: "wager_retries_total",
    help: "Tentativas agendadas de novo, por origem",
    labelNames: ["source"],
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter({
    name: "wager_dead_letter_total",
    help: "Mensagens enviadas explicitamente à DLQ, por motivo permanente",
    labelNames: ["reason"],
    registers: [this.registry],
  });

  private readonly lockTimeouts = new Counter({
    name: "wager_lock_timeouts_total",
    help: "Transações que estouraram o lock_timeout esperando um lock",
    registers: [this.registry],
  });

  private readonly lockWait = new Histogram({
    name: "wager_wallet_lock_wait_seconds",
    help: "Tempo de espera pelo lock da wallet",
    buckets: SECONDS_BUCKETS,
    registers: [this.registry],
  });

  private readonly lag = new Gauge({
    name: "wager_outbox_lag_seconds",
    help: "Idade, em segundos, da mensagem pendente mais antiga da outbox (0 se não há pendentes)",
    registers: [this.registry],
  });

  private readonly processing = new Histogram({
    name: "wager_processing_duration_seconds",
    help: "Latência do processamento de uma transação, por origem",
    labelNames: ["source"],
    buckets: SECONDS_BUCKETS,
    registers: [this.registry],
  });

  private readonly mismatches = new Counter({
    name: "wager_reconciliation_mismatches_total",
    help: "Reconciliações que encontraram divergência entre saldo e ledger",
    registers: [this.registry],
  });

  constructor(options: { defaultMetrics: boolean }) {
    if (options.defaultMetrics) {
      collectDefaultMetrics({ register: this.registry });
    }
  }

  transactionRecorded(kind: string, status: string): void {
    this.transactions.inc({ kind, status });
  }

  duplicateDetected(type: DuplicateType, source: ProcessingSource): void {
    this.duplicates.inc({ type, source });
  }

  retryScheduled(source: RetrySource): void {
    this.retries.inc({ source });
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  lockTimeout(): void {
    this.lockTimeouts.inc();
  }

  walletLockWaited(seconds: number): void {
    this.lockWait.observe(seconds);
  }

  outboxLag(seconds: number): void {
    this.lag.set(seconds);
  }

  processingDuration(source: ProcessingSource, seconds: number): void {
    this.processing.observe({ source }, seconds);
  }

  reconciliationMismatch(): void {
    this.mismatches.inc();
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
