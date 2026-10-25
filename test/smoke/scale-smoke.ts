import { randomUUID } from "node:crypto";
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const FIRST_PORT = 3000;
const LAST_PORT = 3009;
const MIN_INSTANCES = Number(process.env.SMOKE_MIN_INSTANCES ?? 2);
const SQS_ENDPOINT = process.env.SMOKE_SQS_ENDPOINT ?? "http://localhost:4566";
const INPUT_QUEUE = process.env.SQS_TRANSACTIONS_QUEUE ?? "wager-transactions.fifo";
const PARALLEL_REQUESTS = 50;
const QUEUE_TIMEOUT_MS = 30_000;
const RETRY_INTERVAL_MS = 100;

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

let failures = 0;

function check(description: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? "OK    " : "FALHOU"} ${description}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`,
  );

  if (!ok) {
    failures += 1;
  }
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function call(base: string, path: string, init: RequestInit = {}): Promise<Reply> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();

  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function post(base: string, path: string, body: unknown, key?: string): Promise<Reply> {
  for (;;) {
    const reply = await call(base, path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key && { "Idempotency-Key": key }) },
      body: JSON.stringify(body),
    });

    if (reply.status !== 503) {
      return reply;
    }

    await delay(RETRY_INTERVAL_MS);
  }
}

async function discoverInstances(): Promise<string[]> {
  const configured = process.env.SMOKE_URLS?.split(",").map((url) => url.trim());
  const candidates =
    configured ??
    Array.from(
      { length: LAST_PORT - FIRST_PORT + 1 },
      (_, index) => `http://localhost:${FIRST_PORT + index}`,
    );
  const ready: string[] = [];

  for (const url of candidates) {
    try {
      const reply = await call(url, "/health/ready", { signal: AbortSignal.timeout(2000) });

      if (reply.status === 200) {
        ready.push(url);
      }
    } catch {}
  }

  return ready;
}

async function counter(
  base: string,
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const text = await (await fetch(`${base}/metrics`)).text();
  let total = 0;

  for (const line of text.split("\n")) {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)$/.exec(line);

    if (!match || match[1] !== name) {
      continue;
    }

    const present = new Map<string, string>();
    for (const pair of (match[3] ?? "").matchAll(/(\w+)="([^"]*)"/g)) {
      present.set(pair[1] as string, pair[2] as string);
    }

    if (Object.entries(labels).every(([key, value]) => present.get(key) === value)) {
      total += Number(match[4]);
    }
  }

  return total;
}

const sum = async (urls: string[], name: string, labels: Record<string, string>) =>
  (await Promise.all(urls.map((url) => counter(url, name, labels)))).reduce((a, b) => a + b, 0);

async function openWallet(
  base: string,
  balance: string,
): Promise<{ id: string; playerId: string }> {
  const playerId = `smoke-${randomUUID()}`;
  const reply = await post(base, "/wallets", {
    playerId,
    initialBalance: { amount: balance, currency: "BRL" },
  });

  if (reply.status !== 201) {
    throw new Error(`não abriu a wallet: ${reply.status} ${JSON.stringify(reply.body)}`);
  }

  return { id: reply.body.id as string, playerId };
}

function bet(wallet: { id: string; playerId: string }, amount: string) {
  return {
    providerId: "smoke",
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "game-1",
    kind: "BET",
    money: { amount, currency: "BRL" },
  };
}

const keyOf = (payload: { providerId: string; externalTransactionId: string }) =>
  `${payload.providerId}:${payload.externalTransactionId}`;

async function balanceOf(base: string, walletId: string): Promise<string> {
  const reply = await call(base, `/wallets/${walletId}`);

  return (reply.body.balance as { amount: string }).amount;
}

async function ledgerSize(base: string, walletId: string): Promise<number> {
  const reply = await call(base, `/wallets/${walletId}/ledger?limit=200`);

  return (reply.body.items as unknown[]).length;
}

async function sendToQueue(payload: ReturnType<typeof bet>): Promise<string> {
  const client = new SQSClient({
    region: "us-east-1",
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const messageId = `msg-${randomUUID()}`;

  try {
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: INPUT_QUEUE }));

    await client.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl,
        MessageGroupId: payload.walletId,
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: { ...payload, idempotencyKey: keyOf(payload) },
        }),
      }),
    );
  } finally {
    client.destroy();
  }

  return messageId;
}

const instances = await discoverInstances();
console.log(`Instâncias prontas (${instances.length}): ${instances.join(", ")}`);
check(
  `há pelo menos ${MIN_INSTANCES} instâncias respondendo /health/ready`,
  instances.length >= MIN_INSTANCES,
  instances,
);

if (instances.length < MIN_INSTANCES) {
  process.exit(1);
}

const pick = (index: number) => instances[index % instances.length] as string;

console.log("\n== A mesma BET 50 vezes em paralelo, distribuída entre as instâncias");
const walletA = await openWallet(pick(0), "100.00");
const sameBet = bet(walletA, "10.00");
const before = {
  processed: await sum(instances, "wager_transactions_total", { kind: "BET", status: "PROCESSED" }),
  replays: await sum(instances, "wager_duplicates_total", {
    type: "idempotent_replay",
    source: "http",
  }),
};
const perInstanceBefore = await Promise.all(
  instances.map((url) =>
    counter(url, "wager_processing_duration_seconds_count", { source: "http" }),
  ),
);
const replies = await Promise.all(
  Array.from({ length: PARALLEL_REQUESTS }, (_, index) =>
    post(pick(index), "/wagering/transactions", sameBet, keyOf(sameBet)),
  ),
);
const processed =
  (await sum(instances, "wager_transactions_total", { kind: "BET", status: "PROCESSED" })) -
  before.processed;
const replays =
  (await sum(instances, "wager_duplicates_total", { type: "idempotent_replay", source: "http" })) -
  before.replays;
const perInstanceAfter = await Promise.all(
  instances.map((url) =>
    counter(url, "wager_processing_duration_seconds_count", { source: "http" }),
  ),
);

check(
  "as 50 respostas foram 200",
  replies.every((reply) => reply.status === 200),
  replies.map((r) => r.status),
);
check(
  "todas devolveram o mesmo transactionId",
  new Set(replies.map((reply) => reply.body.transactionId)).size === 1,
);
check("1 execução (wager_transactions_total PROCESSED +1)", processed === 1, processed);
check(
  "49 replays (wager_duplicates_total idempotent_replay +49)",
  replays === PARALLEL_REQUESTS - 1,
  replays,
);
check(
  "cada instância recebeu requisições",
  perInstanceAfter.every((value, index) => value > (perInstanceBefore[index] as number)),
  perInstanceAfter.map((value, index) => value - (perInstanceBefore[index] as number)),
);
check("saldo 90.00 (1 débito)", (await balanceOf(pick(1), walletA.id)) === "90.00");
check(
  "ledger com 2 lançamentos (abertura + 1 débito)",
  (await ledgerSize(pick(2), walletA.id)) === 2,
);

console.log("\n== Duas BETs de 80.00 sobre 100.00, em instâncias diferentes");
const walletB = await openWallet(pick(0), "100.00");
const first = bet(walletB, "80.00");
const second = bet(walletB, "80.00");
const race = await Promise.all([
  post(pick(0), "/wagering/transactions", first, keyOf(first)),
  post(pick(1), "/wagering/transactions", second, keyOf(second)),
]);
check(
  "uma 200 (PROCESSED) e uma 422 (REJECTED)",
  JSON.stringify(race.map((reply) => reply.status).sort()) === JSON.stringify([200, 422]),
  race.map((reply) => reply.status),
);
check("saldo 20.00", (await balanceOf(pick(2), walletB.id)) === "20.00");
check(
  "ledger com 2 lançamentos (abertura + 1 débito)",
  (await ledgerSize(pick(2), walletB.id)) === 2,
);

console.log("\n== Mensagem pela fila de entrada (SQS)");
const walletC = await openWallet(pick(0), "100.00");
const queued = bet(walletC, "25.00");
const sqsBefore = await Promise.all(
  instances.map((url) =>
    counter(url, "wager_processing_duration_seconds_count", { source: "sqs" }),
  ),
);
const messageId = await sendToQueue(queued);
console.log(`mensagem ${messageId} enviada para ${INPUT_QUEUE}`);

const deadline = Date.now() + QUEUE_TIMEOUT_MS;
let status: string | undefined;

while (Date.now() < deadline) {
  const reply = await call(
    pick(0),
    `/providers/${queued.providerId}/wagering/transactions/${queued.externalTransactionId}`,
  );

  if (reply.status === 200) {
    status = reply.body.status as string;
    break;
  }

  await delay(250);
}

const sqsAfter = await Promise.all(
  instances.map((url) =>
    counter(url, "wager_processing_duration_seconds_count", { source: "sqs" }),
  ),
);
const handledBy = instances.filter(
  (_, index) => (sqsAfter[index] as number) > (sqsBefore[index] as number),
);
check("a transação enviada pela fila foi processada (PROCESSED)", status === "PROCESSED", status);
check("alguma instância registrou o processamento (source=sqs)", handledBy.length >= 1, handledBy);
console.log(`processada por: ${handledBy.join(", ")}`);
check("saldo 75.00", (await balanceOf(pick(1), walletC.id)) === "75.00");

console.log(failures === 0 ? "\nTUDO CERTO" : `\n${failures} verificação(ões) falharam`);
process.exit(failures === 0 ? 0 : 1);
