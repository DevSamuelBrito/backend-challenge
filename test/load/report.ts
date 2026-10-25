import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EnvironmentInfo } from "./cluster";
import type { ScenarioResult } from "./runner";
import { type Spread, spreadOf } from "./stats";

const REGIONS = ["environment", "results", "correctness"] as const;
type Region = (typeof REGIONS)[number];

export interface ScenarioAggregate {
  id: string;
  title: string;
  rounds: number;
  concurrency: number;
  requests: Spread;
  durationSeconds: Spread;
  throughput: Spread;
  p50: Spread;
  p95: Spread;
  p99: Spread;
  max: Spread;
  technicalErrors: Spread;
  conflicts: Spread;
  businessRejections: Spread;
  pending202: Spread;
  lockTimeouts: Spread;
  lockAcquisitions: Spread;
  lockMeanWaitMs: Spread;
  lockP95Ms: Spread;
  lockP99Ms: Spread;
  serverP95Ms: Spread;
  serverP99Ms: Spread;
  peakLagSeconds: Spread;
  backlogAtLoadEnd: Spread;
  drainSeconds: Spread;
  drainRate: Spread;
  pendingResolutionP50: Spread;
  pendingResolutionMax: Spread;
  pendingTotal: Spread;
  statusCounts: Record<string, Spread>;
}

const collect = (
  rounds: readonly ScenarioResult[],
  pick: (result: ScenarioResult) => number,
): Spread => spreadOf(rounds.map(pick));

export function aggregate(results: readonly ScenarioResult[]): ScenarioAggregate[] {
  const ids = [...new Set(results.map((result) => result.id))];

  return ids.map((id) => {
    const rounds = results.filter((result) => result.id === id);
    const first = rounds[0] as ScenarioResult;
    const statuses = [
      ...new Set(rounds.flatMap((result) => Object.keys(result.statusCounts))),
    ].sort();

    return {
      id,
      title: first.title,
      rounds: rounds.length,
      concurrency: first.concurrency,
      requests: collect(rounds, (r) => r.requests),
      durationSeconds: collect(rounds, (r) => r.durationMs / 1000),
      throughput: collect(rounds, (r) => r.throughput),
      p50: collect(rounds, (r) => r.latency.p50),
      p95: collect(rounds, (r) => r.latency.p95),
      p99: collect(rounds, (r) => r.latency.p99),
      max: collect(rounds, (r) => r.latency.max),
      technicalErrors: collect(rounds, (r) => r.technicalErrors),
      conflicts: collect(rounds, (r) => r.conflicts),
      businessRejections: collect(rounds, (r) => r.businessRejections),
      pending202: collect(rounds, (r) => r.pending202),
      lockTimeouts: collect(rounds, (r) => r.lock.timeouts),
      lockAcquisitions: collect(rounds, (r) => r.lock.acquisitions),
      lockMeanWaitMs: collect(rounds, (r) => r.lock.meanWaitMs),
      lockP95Ms: collect(rounds, (r) => r.lock.p95Ms),
      lockP99Ms: collect(rounds, (r) => r.lock.p99Ms),
      serverP95Ms: collect(rounds, (r) => r.server.p95Ms),
      serverP99Ms: collect(rounds, (r) => r.server.p99Ms),
      peakLagSeconds: collect(rounds, (r) => r.outbox.peakLagSeconds),
      backlogAtLoadEnd: collect(rounds, (r) => r.outbox.backlogAtLoadEnd),
      drainSeconds: collect(rounds, (r) => r.outbox.drainSeconds),
      drainRate: collect(rounds, (r) =>
        r.outbox.drainSeconds > 0 ? r.outbox.backlogAtLoadEnd / r.outbox.drainSeconds : Number.NaN,
      ),
      pendingResolutionP50: collect(rounds, (r) => r.pending?.resolutionP50Seconds ?? Number.NaN),
      pendingResolutionMax: collect(rounds, (r) => r.pending?.resolutionMaxSeconds ?? Number.NaN),
      pendingTotal: collect(rounds, (r) => r.pending?.total ?? Number.NaN),
      statusCounts: Object.fromEntries(
        statuses.map((status) => [status, collect(rounds, (r) => r.statusCounts[status] ?? 0)]),
      ),
    };
  });
}

function number(value: number, digits = 0): string {
  if (Number.isNaN(value)) {
    return "—";
  }

  if (!Number.isFinite(value)) {
    return "∞";
  }

  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function cell(spread: Spread, digits = 0): string {
  if (Number.isNaN(spread.median)) {
    return "—";
  }

  const same = number(spread.min, digits) === number(spread.max, digits);

  return same
    ? number(spread.median, digits)
    : `${number(spread.median, digits)} (${number(spread.min, digits)}–${number(spread.max, digits)})`;
}

function bucketCell(spread: Spread): string {
  if (Number.isNaN(spread.median)) {
    return "—";
  }

  return spread.max === Number.POSITIVE_INFINITY ? `${cell(spread)} ou mais` : `≤ ${cell(spread)}`;
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;

  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export function renderEnvironment(environment: EnvironmentInfo): string {
  const app = environment.app;
  const rows: string[][] = [
    ["Data da execução", environment.capturedAt],
    ["Sistema operacional do gerador de carga", environment.host.os],
    ["CPU", `${environment.host.cpuModel} (${environment.host.logicalCores} núcleos lógicos)`],
    ["Memória do computador", `${environment.host.memoryGiB} GiB`],
    [
      "Docker / Compose",
      `${environment.docker.serverVersion} / ${environment.docker.composeVersion}`,
    ],
    [
      "VM do Docker",
      `${environment.docker.vmCpus} CPUs, ${environment.docker.vmMemoryGiB} GiB (${environment.docker.vmOs})`,
    ],
    ["Bun (gerador de carga)", environment.bunVersion],
    ["Instâncias da aplicação", String(environment.instances)],
    [
      "PostgreSQL",
      `${environment.postgres.version}; max_connections=${environment.postgres.maxConnections}; shared_buffers=${environment.postgres.sharedBuffers}`,
    ],
  ];

  if (app) {
    rows.push(
      ["Papéis de cada instância", app.roles],
      [
        "Pool de conexões",
        `${app.connectionPoolMax} por instância (padrão do driver pg; o projeto não configura)`,
      ],
      ["lock_timeout", `${app.databaseLockTimeoutMs} ms`],
      [
        "Publicador da outbox",
        `lote de ${app.outboxBatchSize} a cada ${app.outboxTickIntervalMs} ms, por instância`,
      ],
      [
        "Worker de pendências",
        `lote de ${app.pendingBatchSize} a cada ${app.pendingTickIntervalMs} ms; ${app.pendingMaxAttempts} tentativas ou ${app.pendingTtlMs / 1000} s`,
      ],
    );
  }

  const load = environment.load;
  rows.push(
    ["Concorrência do gerador (closed-loop)", `${load.concurrency} trabalhadores`],
    ["Rodadas", String(load.rounds)],
    ["Aquecimento", `${load.warmupRequests} requisições por rodada, descartadas`],
    [
      "Tamanho dos cenários",
      `${load.distinctWallets} wallets × 6 operações; ${load.hotWalletBets} BETs na hot wallet; ` +
        `${load.replayRequests} replays sobre ${load.replayKeys} chaves; ` +
        `${load.mixedWallets * load.mixedPairsPerWallet} pares BET+reversão (${load.earlyReversalPercent}% com a reversão antes da BET)`,
    ],
  );

  return table(["Item", "Valor"], rows);
}

export function renderResults(aggregates: readonly ScenarioAggregate[], rounds: number): string {
  const parts: string[] = [];

  parts.push(
    `Cada célula mostra **mediana (mín–máx)** das ${rounds} rodada(s). Latências em milissegundos medidas no gerador de carga (do envio ao fim da resposta).`,
    "",
    "#### Vazão e latência",
    "",
    table(
      ["Cenário", "Requisições", "Duração (s)", "Vazão (req/s)", "p50", "p95", "p99", "máx"],
      aggregates.map((a) => [
        a.title,
        cell(a.requests),
        cell(a.durationSeconds, 1),
        cell(a.throughput),
        cell(a.p50),
        cell(a.p95),
        cell(a.p99),
        cell(a.max),
      ]),
    ),
    "",
    "#### Status HTTP e erros",
    "",
  );

  const statuses = [...new Set(aggregates.flatMap((a) => Object.keys(a.statusCounts)))].sort();

  parts.push(
    table(
      [
        "Cenário",
        ...statuses.map((status) => `HTTP ${status}`),
        "Erros técnicos (5xx, 503, timeout)",
      ],
      aggregates.map((a) => [
        a.title,
        ...statuses.map((status) => (a.statusCounts[status] ? cell(a.statusCounts[status]) : "0")),
        cell(a.technicalErrors),
      ]),
    ),
    "",
    "#### Disputa de lock da wallet (somada nas instâncias, lida em `/metrics` antes e depois)",
    "",
    table(
      [
        "Cenário",
        "Aquisições do lock",
        "Espera média (ms)",
        "Espera p95 (ms)",
        "Espera p99 (ms)",
        "Lock timeouts",
        "Servidor p95 (ms)",
        "Servidor p99 (ms)",
      ],
      aggregates.map((a) => [
        a.title,
        cell(a.lockAcquisitions),
        cell(a.lockMeanWaitMs, 1),
        bucketCell(a.lockP95Ms),
        bucketCell(a.lockP99Ms),
        cell(a.lockTimeouts),
        bucketCell(a.serverP95Ms),
        bucketCell(a.serverP99Ms),
      ]),
    ),
    "",
    "Os percentis do histograma do servidor têm a resolução dos *buckets* do Prometheus (`≤ X` é o limite superior do bucket onde o percentil cai).",
    "",
    "#### Outbox",
    "",
    table(
      [
        "Cenário",
        "Pico do lag (s)",
        "Eventos pendentes ao fim da carga",
        "Tempo até drenar (s)",
        "Vazão de drenagem (eventos/s)",
      ],
      aggregates.map((a) => [
        a.title,
        cell(a.peakLagSeconds, 1),
        cell(a.backlogAtLoadEnd),
        cell(a.drainSeconds, 1),
        cell(a.drainRate, 1),
      ]),
    ),
  );

  const withPending = aggregates.filter((a) => !Number.isNaN(a.pendingTotal.median));

  if (withPending.length > 0) {
    parts.push(
      "",
      "#### Reversões que chegaram antes da referência (202 → resolvida pelo worker)",
      "",
      table(
        ["Cenário", "Reversões em 202", "Resolução p50 (s)", "Resolução máx (s)"],
        withPending.map((a) => [
          a.title,
          cell(a.pendingTotal),
          cell(a.pendingResolutionP50, 2),
          cell(a.pendingResolutionMax, 2),
        ]),
      ),
    );
  }

  return parts.join("\n");
}

export function renderCorrectness(results: readonly ScenarioResult[]): string {
  const total = results.reduce((sum, result) => sum + result.checks.length, 0);
  const failed = results.flatMap((result) =>
    result.checks.filter((entry) => !entry.ok).map((entry) => ({ result, entry })),
  );
  const names = [...new Set(results.flatMap((result) => result.checks.map((entry) => entry.name)))];
  const scenarios = [...new Set(results.map((result) => result.title))];

  const matrix = table(
    ["Cenário", "Verificações aprovadas", "Verificações reprovadas"],
    scenarios.map((title) => {
      const own = results.filter((result) => result.title === title);
      const checks = own.flatMap((result) => result.checks);

      return [
        title,
        String(checks.filter((entry) => entry.ok).length),
        String(checks.filter((entry) => !entry.ok).length),
      ];
    }),
  );

  const lines = [
    failed.length === 0
      ? `**Todas as ${total} verificações passaram** (${results.length} execuções de cenário).`
      : `**${failed.length} de ${total} verificações FALHARAM.**`,
    "",
    matrix,
    "",
    "Verificações feitas ao final de cada cenário, em cada rodada:",
    "",
    ...names.map((name) => `- ${name}`),
  ];

  if (failed.length > 0) {
    lines.push(
      "",
      "Falhas:",
      "",
      ...failed.map(
        ({ result, entry }) =>
          `- rodada ${result.round}, ${result.title}: ${entry.name} → ${entry.detail}`,
      ),
    );
  }

  return lines.join("\n");
}

const marker = (region: Region, edge: "start" | "end") => `<!-- load:${region}:${edge} -->`;

export function replaceRegion(document: string, region: Region, content: string): string {
  const start = marker(region, "start");
  const end = marker(region, "end");
  const from = document.indexOf(start);
  const to = document.indexOf(end);
  const block = `${start}\n${content}\n${end}`;

  if (from === -1 || to === -1 || to < from) {
    return `${document.trimEnd()}\n\n${block}\n`;
  }

  return `${document.slice(0, from)}${block}${document.slice(to + end.length)}`;
}

export function writeReport(
  path: string,
  environment: EnvironmentInfo,
  results: readonly ScenarioResult[],
  rounds: number,
): void {
  let document = existsSync(path) ? readFileSync(path, "utf8") : "# Teste de carga\n";

  document = replaceRegion(document, "environment", renderEnvironment(environment));
  document = replaceRegion(document, "results", renderResults(aggregate(results), rounds));
  document = replaceRegion(document, "correctness", renderCorrectness(results));
  writeFileSync(path, document);
}
