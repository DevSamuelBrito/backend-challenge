import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

const CONSOLE_PORT = Number(process.env.CONSOLE_PORT ?? 4000);
const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
const INPUT_QUEUE = process.env.SQS_TRANSACTIONS_QUEUE ?? "wager-transactions.fifo";
const DEAD_LETTER_QUEUE = process.env.SQS_TRANSACTIONS_DLQ ?? "wager-transactions-dlq.fifo";
const FIRST_APP_PORT = 3000;
const LAST_APP_PORT = 3009;
const PROBE_TIMEOUT_MS = 3000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

interface TransactionPayload {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  idempotencyKey?: string;
  [key: string]: unknown;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function probeInstances() {
  const ports = Array.from(
    { length: LAST_APP_PORT - FIRST_APP_PORT + 1 },
    (_, index) => FIRST_APP_PORT + index,
  );
  const results = await Promise.all(
    ports.map(async (port) => {
      try {
        const reply = await fetch(`http://127.0.0.1:${port}/health/ready`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return reply.ok ? { port } : { port, error: `HTTP ${reply.status}` };
      } catch (error) {
        return { port, error: String(error) };
      }
    }),
  );
  return {
    ports: results.filter((result) => !result.error).map((result) => result.port),
    errors: Object.fromEntries(
      results.flatMap((result) => (result.error ? [[result.port, result.error]] : [])),
    ),
  };
}

async function proxy(request: Request, url: URL) {
  const target = request.headers.get("x-target") ?? "";
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return json({ error: "Cabeçalho x-target inválido" }, 400);
  }
  if (!LOCAL_HOSTS.has(targetUrl.hostname)) {
    return json({ error: "Só são aceitos destinos em localhost" }, 400);
  }

  const path = url.pathname.slice("/api".length) + url.search;
  const headers = new Headers();
  for (const name of ["content-type", "idempotency-key", "x-correlation-id"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  try {
    const host = targetUrl.hostname === "localhost" ? "127.0.0.1" : targetUrl.hostname;
    const reply = await fetch(`http://${host}:${targetUrl.port || 80}${path}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.text() : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    return new Response(await reply.text(), {
      status: reply.status,
      headers: { "content-type": reply.headers.get("content-type") ?? "text/plain" },
    });
  } catch (error) {
    return json({ error: `Não consegui falar com ${targetUrl.origin}: ${String(error)}` }, 502);
  }
}

async function sendToQueue(request: Request) {
  const payload = (await request.json()) as TransactionPayload;
  const idempotencyKey =
    payload.idempotencyKey ?? `${payload.providerId}:${payload.externalTransactionId}`;
  const messageId = `msg-${randomUUID()}`;
  const client = new SQSClient({
    region: "us-east-1",
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  try {
    const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: INPUT_QUEUE }));
    await client.send(
      new SendMessageCommand({
        QueueUrl,
        MessageGroupId: payload.walletId,
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: { ...payload, idempotencyKey },
        }),
      }),
    );
    return json({ enqueued: true, messageId, queue: INPUT_QUEUE });
  } catch (error) {
    return json({ enqueued: false, error: String(error) }, 502);
  } finally {
    client.destroy();
  }
}

async function deadLetterDepth() {
  const client = new SQSClient({
    region: "us-east-1",
    endpoint: SQS_ENDPOINT,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  try {
    const { QueueUrl } = await client.send(
      new GetQueueUrlCommand({ QueueName: DEAD_LETTER_QUEUE }),
    );
    const { Attributes } = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    );
    const visible = Number(Attributes?.ApproximateNumberOfMessages ?? 0);
    const inFlight = Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);

    return json({ messages: visible + inFlight });
  } catch (error) {
    return json({ error: String(error) }, 502);
  } finally {
    client.destroy();
  }
}

Bun.serve({
  hostname: "127.0.0.1",
  port: CONSOLE_PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(Bun.file(join(import.meta.dir, "index.html")));
    if (url.pathname === "/instances") return json(await probeInstances());
    if (url.pathname === "/sqs" && request.method === "POST") return sendToQueue(request);
    if (url.pathname === "/dlq") return deadLetterDepth();
    if (url.pathname.startsWith("/api/")) return proxy(request, url);
    return json({ error: "não encontrado" }, 404);
  },
});

console.log(`Console de testes em http://localhost:${CONSOLE_PORT}`);
