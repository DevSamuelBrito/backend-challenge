import { resolve } from "node:path";
import type { AppRole } from "../../src/config/env";
import type { FaultPoint } from "../../src/shared/application/fault-injector.port";
import { CONSUMER_TEST_ENV } from "./consumer";
import { createHttpClient, type HttpClient } from "./http";
import { type LogLine, scrape } from "./observability";
import { testConfig } from "./test-config";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const DEFAULT_READY_TIMEOUT_MS = 40_000;
const DEFAULT_EXIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;
const OUTPUT_FLUSH_GRACE_MS = 2000;
const NEST_STARTUP_NOISE = /"context":"(RouterExplorer|RoutesResolver|InstanceLoader)"/;

export interface HarnessInfra {
  databaseUrl: string;
  inputQueue: string;
  dlqQueue: string;
  eventsQueue: string;
  env?: Record<string, string>;
}

export interface ProcessSpec {
  name?: string;
  roles: readonly AppRole[];
  faultPoint?: FaultPoint;
  env?: Record<string, string>;
}

export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
  snapshot?: () => Promise<string> | string;
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function pollUntil(
  description: string,
  condition: () => boolean | Promise<boolean>,
  options: PollOptions = {},
): Promise<void> {
  const { timeoutMs = 30_000, intervalMs = POLL_INTERVAL_MS, snapshot } = options;
  const deadline = Date.now() + timeoutMs;

  while (!(await condition())) {
    if (Date.now() > deadline) {
      const state = snapshot ? `\nEstado observado: ${await snapshot()}` : "";
      throw new Error(`Tempo esgotado (${timeoutMs}ms) esperando: ${description}${state}`);
    }

    await delay(intervalMs);
  }
}

type Stream = "stdout" | "stderr";

interface OutputLine {
  stream: Stream;
  text: string;
}

type Child = ReturnType<typeof spawnChild>;

function spawnChild(env: Record<string, string>) {
  return Bun.spawn([process.execPath, "src/main.ts"], {
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function pump(
  source: ReadableStream<Uint8Array>,
  stream: Stream,
  sink: (line: OutputLine) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";

  for await (const chunk of source) {
    pending += decoder.decode(chunk, { stream: true });

    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      sink({ stream, text: pending.slice(0, end).replace(/\r$/, "") });
      pending = pending.slice(end + 1);
    }
  }

  if (pending !== "") {
    sink({ stream, text: pending });
  }
}

export class AppProcess {
  readonly lines: OutputLine[] = [];
  readonly exited: Promise<number>;
  private readonly child: Child;
  private port: number | undefined;
  private code: number | null = null;
  private client: HttpClient | undefined;

  constructor(
    readonly name: string,
    readonly roles: readonly AppRole[],
    env: Record<string, string>,
  ) {
    this.child = spawnChild(env);

    const pumps = Promise.all([
      pump(this.child.stdout, "stdout", (line) => this.receive(line)),
      pump(this.child.stderr, "stderr", (line) => this.receive(line)),
    ]);

    this.exited = this.child.exited.then(async (exitCode) => {
      this.code = exitCode;
      await Promise.race([pumps, delay(OUTPUT_FLUSH_GRACE_MS)]);

      return exitCode;
    });
  }

  get pid(): number {
    return this.child.pid;
  }

  get alive(): boolean {
    return this.code === null;
  }

  get isListening(): boolean {
    return this.port !== undefined;
  }

  get exitCode(): number | null {
    return this.code;
  }

  get url(): string {
    if (this.port === undefined) {
      throw new Error(`${this.name} ainda não informou a porta\n${this.output()}`);
    }

    return `http://127.0.0.1:${this.port}`;
  }

  get http(): HttpClient {
    this.client ??= createHttpClient(this.url);

    return this.client;
  }

  get logs(): LogLine[] {
    return this.lines
      .filter((line) => line.stream === "stdout" && line.text.startsWith("{"))
      .flatMap((line) => {
        try {
          return [JSON.parse(line.text) as LogLine];
        } catch {
          return [];
        }
      });
  }

  events(event: string): LogLine[] {
    return this.logs.filter((line) => line.event === event);
  }

  output(): string {
    return this.lines
      .filter((line) => !NEST_STARTUP_NOISE.test(line.text))
      .map((line) => `[${this.name} ${line.stream}] ${line.text}`)
      .join("\n");
  }

  metrics(): Promise<string> {
    return scrape(this.http);
  }

  async waitUntilReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.alive) {
        throw new Error(
          `${this.name} terminou (código ${this.code}) antes de ficar pronto\n${this.output()}`,
        );
      }

      if (this.port !== undefined && (await this.answersReady())) {
        return;
      }

      await delay(POLL_INTERVAL_MS);
    }

    throw new Error(`${this.name} não ficou pronto em ${timeoutMs}ms\n${this.output()}`);
  }

  async kill(): Promise<void> {
    if (this.alive) {
      this.killNow();
    }

    await this.exited;
  }

  killNow(): void {
    try {
      this.child.kill("SIGKILL");
    } catch {}
  }

  signal(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  async waitForExit(timeoutMs = DEFAULT_EXIT_TIMEOUT_MS): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`${this.name} não terminou em ${timeoutMs}ms\n${this.output()}`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private receive(line: OutputLine): void {
    this.lines.push(line);

    if (
      this.port === undefined &&
      line.stream === "stdout" &&
      line.text.includes("app.listening")
    ) {
      try {
        const parsed = JSON.parse(line.text) as { event?: string; port?: number };

        if (parsed.event === "app.listening" && typeof parsed.port === "number") {
          this.port = parsed.port;
        }
      } catch {}
    }
  }

  private async answersReady(): Promise<boolean> {
    try {
      const response = await fetch(`${this.url}/health/ready`, {
        signal: AbortSignal.timeout(1500),
      });

      return response.status === 200;
    } catch {
      return false;
    }
  }
}

const everyProcess = new Set<AppProcess>();
let exitHooksInstalled = false;

function killEveryProcess(): void {
  for (const process of everyProcess) {
    if (process.alive) {
      process.killNow();
    }
  }
}

function installExitHooks(): void {
  if (exitHooksInstalled) {
    return;
  }

  exitHooksInstalled = true;
  process.on("exit", killEveryProcess);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killEveryProcess();
      process.exit(130);
    });
  }
}

export class ProcessHarness {
  private readonly processes: AppProcess[] = [];
  private sequence = 0;

  constructor(private readonly infra: HarnessInfra) {
    installExitHooks();
  }

  get all(): readonly AppProcess[] {
    return this.processes;
  }

  get running(): AppProcess[] {
    return this.processes.filter((candidate) => candidate.alive);
  }

  spawn(spec: ProcessSpec): AppProcess {
    this.sequence += 1;
    const name = spec.name ?? `p${this.sequence}`;
    const child = new AppProcess(name, spec.roles, this.environmentFor(spec));

    this.processes.push(child);
    everyProcess.add(child);

    return child;
  }

  async start(spec: ProcessSpec): Promise<AppProcess> {
    const [started] = await this.startAll([spec]);

    return started as AppProcess;
  }

  async startAll(specs: readonly ProcessSpec[]): Promise<AppProcess[]> {
    const spawned = specs.map((spec) => this.spawn(spec));
    await Promise.all(spawned.map((child) => child.waitUntilReady()));

    return spawned;
  }

  async killAll(): Promise<void> {
    await Promise.all(this.running.map((child) => child.kill()));
  }

  async dispose(): Promise<void> {
    await Promise.all(this.processes.map((child) => child.kill()));
    this.assertNoLiveChildren();
  }

  assertNoLiveChildren(): void {
    const alive = this.processes.filter((child) => child.alive);

    if (alive.length > 0) {
      throw new Error(
        `processos filhos ainda vivos: ${alive.map((child) => `${child.name} (pid ${child.pid})`).join(", ")}`,
      );
    }
  }

  report(): string {
    return this.processes
      .map((child) => {
        const state = child.alive ? "vivo" : `terminou com código ${child.exitCode}`;

        return `===== ${child.name} [${child.roles.join(",")}] pid ${child.pid} (${state}) =====\n${child.output()}`;
      })
      .join("\n");
  }

  private environmentFor(spec: ProcessSpec): Record<string, string> {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" &&
          entry[0] !== "ENABLE_FAULT_INJECTION" &&
          entry[0] !== "FAULT_POINT",
      ),
    );

    return {
      ...inherited,
      PORT: "0",
      APP_ROLES: spec.roles.join(","),
      DATABASE_URL: this.infra.databaseUrl,
      SQS_ENDPOINT: testConfig().sqs.endpoint ?? "",
      SQS_TRANSACTIONS_QUEUE: this.infra.inputQueue,
      SQS_TRANSACTIONS_DLQ: this.infra.dlqQueue,
      SQS_EVENTS_QUEUE: this.infra.eventsQueue,
      LOG_LEVEL: "info",
      METRICS_DEFAULT_METRICS: "false",
      OUTBOX_INTERVAL_MS: "100",
      OUTBOX_BATCH_SIZE: "50",
      PENDING_WORKER_INTERVAL_MS: "250",
      DLQ_MONITOR_INTERVAL_MS: "500",
      ...CONSUMER_TEST_ENV,
      ...this.infra.env,
      ...spec.env,
      ...(spec.faultPoint && {
        ENABLE_FAULT_INJECTION: "true",
        FAULT_POINT: spec.faultPoint,
      }),
    };
  }
}
