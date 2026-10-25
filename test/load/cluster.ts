import { arch, cpus, platform, release, totalmem } from "node:os";
import { SQL } from "bun";
import { type AppConfig, loadConfig } from "../../src/config/env";
import { type MetricSample, parsePrometheus } from "./prometheus";
import type { LoadSettings } from "./settings";

const APP_PORT = 3000;
const POSTGRES_PORT = 5432;
const PG_POOL_DEFAULT_MAX = 10;

export interface Instance {
  name: string;
  port: number;
  base: string;
}

export interface EnvironmentInfo {
  capturedAt: string;
  host: {
    os: string;
    cpuModel: string;
    logicalCores: number;
    memoryGiB: number;
  };
  docker: {
    serverVersion: string;
    composeVersion: string;
    vmCpus: number;
    vmMemoryGiB: number;
    vmOs: string;
  };
  bunVersion: string;
  instances: number;
  app: {
    databaseLockTimeoutMs: number;
    roles: string;
    outboxTickIntervalMs: number;
    outboxBatchSize: number;
    pendingTickIntervalMs: number;
    pendingBatchSize: number;
    pendingMaxAttempts: number;
    pendingTtlMs: number;
    connectionPoolMax: number;
  } | null;
  postgres: { version: string; maxConnections: string; sharedBuffers: string };
  load: LoadSettings;
}

export async function run(command: string[]): Promise<string> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  if (code !== 0) {
    throw new Error(`${command.join(" ")} falhou (código ${code}): ${stderr.trim()}`);
  }

  return stdout.trim();
}

interface ComposeContainer {
  Name: string;
  State: string;
  Publishers?: { TargetPort: number; PublishedPort: number }[];
}

function parseComposeJson(output: string): ComposeContainer[] {
  const text = output.trim();

  if (text === "") {
    return [];
  }

  if (text.startsWith("[")) {
    return JSON.parse(text) as ComposeContainer[];
  }

  return text.split("\n").map((line) => JSON.parse(line) as ComposeContainer);
}

export async function discoverInstances(minInstances: number): Promise<Instance[]> {
  const output = await run(["docker", "compose", "ps", "--format", "json", "app"]);
  const instances: Instance[] = [];

  for (const container of parseComposeJson(output)) {
    const published = container.Publishers?.find(
      (publisher) => publisher.TargetPort === APP_PORT && publisher.PublishedPort > 0,
    );

    if (container.State !== "running" || !published) {
      continue;
    }

    instances.push({
      name: container.Name,
      port: published.PublishedPort,
      base: `http://127.0.0.1:${published.PublishedPort}`,
    });
  }

  instances.sort((a, b) => a.port - b.port);

  if (instances.length < minInstances) {
    throw new Error(
      `${instances.length} instância(s) do app encontrada(s); o teste exige ao menos ${minInstances}. ` +
        "Suba com: docker compose up --build -d --wait --scale app=3",
    );
  }

  for (const instance of instances) {
    const reply = await fetch(`${instance.base}/health/ready`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);

    if (!reply?.ok) {
      throw new Error(`${instance.name} (${instance.base}) não respondeu 200 em /health/ready`);
    }
  }

  return instances;
}

export async function connectDatabase(): Promise<SQL> {
  const mapping = await run(["docker", "compose", "port", "postgres", String(POSTGRES_PORT)]);
  const port = Number(mapping.split(":").at(-1));

  if (!Number.isInteger(port)) {
    throw new Error(`porta do Postgres não encontrada: ${mapping}`);
  }

  return new SQL({
    hostname: "127.0.0.1",
    port,
    username: process.env.POSTGRES_USER ?? "wagering",
    password: process.env.POSTGRES_PASSWORD ?? "wagering",
    database: process.env.POSTGRES_DB ?? "wagering",
    max: 4,
  });
}

export async function scrapeAll(instances: readonly Instance[]): Promise<MetricSample[]> {
  const bodies = await Promise.all(
    instances.map(async (instance) => {
      const reply = await fetch(`${instance.base}/metrics`, { signal: AbortSignal.timeout(5000) });

      return reply.text();
    }),
  );

  return bodies.flatMap((body) => parsePrometheus(body));
}

async function readAppConfig(): Promise<AppConfig | null> {
  try {
    const output = await run(["docker", "compose", "exec", "-T", "app", "env"]);
    const env: Record<string, string> = {};

    for (const line of output.split("\n")) {
      const separator = line.indexOf("=");

      if (separator > 0) {
        env[line.slice(0, separator)] = line.slice(separator + 1).replace(/\r$/, "");
      }
    }

    return loadConfig(env);
  } catch {
    return null;
  }
}

async function scalar(sql: SQL, statement: string): Promise<string> {
  const rows = (await sql.unsafe(statement)) as Record<string, string>[];

  return String(Object.values(rows[0] ?? {})[0] ?? "?");
}

export async function captureEnvironment(
  instances: readonly Instance[],
  sql: SQL,
  settings: LoadSettings,
): Promise<EnvironmentInfo> {
  const [serverVersion, composeVersion, dockerInfo, config] = await Promise.all([
    run(["docker", "version", "--format", "{{.Server.Version}}"]),
    run(["docker", "compose", "version", "--short"]),
    run(["docker", "info", "--format", "{{.NCPU}}|{{.MemTotal}}|{{.OperatingSystem}}"]),
    readAppConfig(),
  ]);
  const [vmCpus, vmMemory, vmOs] = dockerInfo.split("|");
  const processors = cpus();
  const gib = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

  return {
    capturedAt: new Date().toISOString(),
    host: {
      os: `${platform()} ${release()} (${arch()})`,
      cpuModel: processors[0]?.model.trim() ?? "desconhecido",
      logicalCores: processors.length,
      memoryGiB: gib(totalmem()),
    },
    docker: {
      serverVersion,
      composeVersion,
      vmCpus: Number(vmCpus),
      vmMemoryGiB: gib(Number(vmMemory)),
      vmOs: vmOs ?? "desconhecido",
    },
    bunVersion: Bun.version,
    instances: instances.length,
    app: config && {
      databaseLockTimeoutMs: config.databaseLockTimeoutMs,
      roles: config.roles.join(", "),
      outboxTickIntervalMs: config.outbox.tickIntervalMs,
      outboxBatchSize: config.outbox.batchSize,
      pendingTickIntervalMs: config.pendingReference.tickIntervalMs,
      pendingBatchSize: config.pendingReference.batchSize,
      pendingMaxAttempts: config.pendingReference.maxAttempts,
      pendingTtlMs: config.pendingReference.ttlMs,
      connectionPoolMax: PG_POOL_DEFAULT_MAX,
    },
    postgres: {
      version: (await scalar(sql, "select version()")).split(" on ")[0] ?? "?",
      maxConnections: await scalar(sql, "show max_connections"),
      sharedBuffers: await scalar(sql, "show shared_buffers"),
    },
    load: settings,
  };
}
