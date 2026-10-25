import { test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { type AppRole } from "../../src/config/env";
import { createInputQueues, type InputQueues, wagerMessage } from "./consumer";
import { createMigratedDatabase, type TestDatabase } from "./database";
import type { HttpResult } from "./http";
import { expectInvariants } from "./invariants";
import { metricValue } from "./observability";
import { createEventsQueue, type EventsQueue } from "./outbox";
import {
  type AppProcess,
  type PollOptions,
  ProcessHarness,
  type ProcessSpec,
  pollUntil,
} from "./process-harness";
import { type OpenedWallet, openWallet, type WagerPayload, wagerPayload } from "./wagering-api";

const RETRY_INTERVAL_MS = 100;
const DEFAULT_TEST_TIMEOUT_MS = 120_000;

export const ALL_ROLES: readonly AppRole[] = ["api", "consumer", "outbox", "pending-worker"];

export interface ScenarioOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
  skip?: boolean;
}

export interface Scenario {
  db: TestDatabase;
  client: Client;
  queues: InputQueues;
  events: EventsQueue;
  harness: ProcessHarness;
  start(spec: ProcessSpec): Promise<AppProcess>;
  startAll(specs: readonly ProcessSpec[]): Promise<AppProcess[]>;
  startMany(count: number, spec: Omit<ProcessSpec, "name">): Promise<AppProcess[]>;
  wallet(through: AppProcess, balance?: string, currency?: string): Promise<OpenedWallet>;
  poll(
    description: string,
    condition: () => boolean | Promise<boolean>,
    options?: PollOptions,
  ): Promise<void>;
  dispose(): Promise<void>;
}

export async function createScenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const db = await createMigratedDatabase();
  let queues: InputQueues | undefined;
  let events: EventsQueue | undefined;

  try {
    queues = await createInputQueues();
    events = await createEventsQueue();
  } catch (error) {
    await queues?.close();
    await db.close();
    throw error;
  }

  const harness = new ProcessHarness({
    databaseUrl: db.url,
    inputQueue: queues.inputName,
    dlqQueue: queues.dlqName,
    eventsQueue: events.name,
    env: options.env,
  });

  const readyQueues = queues;
  const readyEvents = events;

  return {
    db,
    client: db.client,
    queues: readyQueues,
    events: readyEvents,
    harness,
    start: (spec) => harness.start(spec),
    startAll: (specs) => harness.startAll(specs),
    startMany: (count, spec) =>
      harness.startAll(Array.from({ length: count }, () => ({ ...spec }))),
    wallet: (through, balance = "100.00", currency = "BRL") =>
      openWallet(through.http, balance, currency),
    poll: (description, condition, pollOptions) =>
      pollUntil(description, condition, {
        snapshot: () => harness.report().slice(-4000),
        ...pollOptions,
      }),
    dispose: async () => {
      try {
        await harness.dispose();
      } finally {
        await readyQueues.close();
        await readyEvents.close();
        await db.close();
      }
    },
  };
}

export function scenarioTest(
  name: string,
  run: (scenario: Scenario) => Promise<void>,
  options: ScenarioOptions = {},
): void {
  const register = options.skip ? test.skip : test;

  register(
    name,
    async () => {
      const scenario = await createScenario(options);

      try {
        await run(scenario);
        await expectInvariants(scenario.client);
      } catch (error) {
        console.error(
          `\n#### saída dos processos do cenário "${name}" ####\n${scenario.harness.report()}`,
        );
        throw error;
      } finally {
        await scenario.dispose();
      }
    },
    options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
  );
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export interface ResilientOptions {
  targets?: () => readonly AppProcess[];
  timeoutMs?: number;
}

export async function submitResilient(
  scenario: Pick<Scenario, "harness">,
  payload: WagerPayload,
  idempotencyKey: string,
  options: ResilientOptions = {},
): Promise<HttpResult> {
  const { timeoutMs = DEFAULT_TEST_TIMEOUT_MS } = options;
  const deadline = Date.now() + timeoutMs;
  const candidates = options.targets ?? (() => scenario.harness.running.filter(isApi));

  for (;;) {
    const listening = candidates().filter((child) => child.alive && child.isListening);
    const target = listening[Math.floor(Math.random() * listening.length)];

    if (target) {
      try {
        const result = await target.http.post("/wagering/transactions", payload, {
          "Idempotency-Key": idempotencyKey,
        });

        if (result.status < 500) {
          return result;
        }
      } catch {}
    }

    if (Date.now() > deadline) {
      throw new Error(`sem resposta definitiva para ${idempotencyKey} em ${timeoutMs}ms`);
    }

    await delay(RETRY_INTERVAL_MS);
  }
}

const isApi = (child: AppProcess) => child.roles.includes("api");

export async function sumMetric(
  processes: readonly AppProcess[],
  name: string,
  labels: Record<string, string> = {},
): Promise<number> {
  const texts = await Promise.all(processes.map((child) => child.metrics()));

  return texts.reduce((total, text) => total + metricValue(text, name, labels), 0);
}

export async function sendWagerMessage(
  queues: InputQueues,
  payload: WagerPayload,
  overrides: Parameters<typeof wagerMessage>[1] = {},
): Promise<ReturnType<typeof wagerMessage>> {
  const message = wagerMessage(payload, overrides);

  await queues.send(message, { groupId: randomUUID(), deduplicationId: randomUUID() });

  return message;
}

export async function ledgerEntryCount(client: Client, walletId: string): Promise<number> {
  const { rows } = await client.query(
    "select count(*)::int as total from wallet_ledger_entries where wallet_id = $1",
    [walletId],
  );

  return rows[0].total as number;
}

export async function transactionCount(client: Client, walletId?: string): Promise<number> {
  const { rows } =
    walletId === undefined
      ? await client.query(
          "select count(*)::int as total from wager_transactions where kind <> 'OPENING'",
        )
      : await client.query(
          "select count(*)::int as total from wager_transactions where wallet_id = $1 and kind <> 'OPENING'",
          [walletId],
        );

  return rows[0].total as number;
}

export async function statusCounts(
  client: Client,
  walletId: string,
): Promise<Record<string, number>> {
  const { rows } = await client.query(
    `select kind || ':' || status as key, count(*)::int as total
       from wager_transactions where wallet_id = $1 and kind <> 'OPENING' group by 1`,
    [walletId],
  );

  return Object.fromEntries(rows.map((row) => [row.key as string, row.total as number]));
}

export function newBet(
  wallet: OpenedWallet,
  amount = "10.00",
  overrides: Partial<WagerPayload> = {},
) {
  return wagerPayload(wallet, { money: { amount, currency: wallet.currency }, ...overrides });
}

export const keyOf = (payload: Pick<WagerPayload, "providerId" | "externalTransactionId">) =>
  `${payload.providerId}:${payload.externalTransactionId}`;

export function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];

  if (item === undefined) {
    throw new Error("lista vazia");
  }

  return item;
}
