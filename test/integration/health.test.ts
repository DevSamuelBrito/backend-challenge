import { afterAll, describe, expect, test } from "bun:test";
import { type RunningApp, startApp } from "../support/app";
import { testConfig } from "../support/test-config";

const running: RunningApp[] = [];

async function boot(overrides: Record<string, string> = {}): Promise<RunningApp> {
  const instance = await startApp(testConfig(overrides));
  running.push(instance);
  return instance;
}

afterAll(async () => {
  await Promise.all(running.map(({ app }) => app.close()));
});

describe("health: com Postgres e SQS reais", () => {
  test("GET /health/live responde 200", async () => {
    const { url } = await boot();

    const response = await fetch(`${url}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("GET /health/ready responde 200 com as duas dependências no ar", async () => {
    const { url } = await boot();

    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      checks: { postgres: "up", sqs: "up" },
    });
  });
});

describe("health: dependência fora do ar", () => {
  test("SQS inalcançável: ready responde 503 e live continua 200", async () => {
    // Porta 1 não tem ninguém escutando: a conexão é recusada.
    const { url } = await boot({ SQS_ENDPOINT: "http://127.0.0.1:1" });

    const ready = await fetch(`${url}/health/ready`);
    const live = await fetch(`${url}/health/live`);

    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      status: "unavailable",
      checks: { postgres: "up", sqs: "down" },
    });
    expect(live.status).toBe(200);
  });

  test("fila de entrada inexistente: ready responde 503", async () => {
    const { url } = await boot({ SQS_TRANSACTIONS_QUEUE: "fila-que-nao-existe.fifo" });

    const ready = await fetch(`${url}/health/ready`);

    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ checks: { postgres: "up", sqs: "down" } });
  });

  test("Postgres inalcançável: ready responde 503 e live continua 200", async () => {
    const { url } = await boot({
      DATABASE_URL: "postgres://wagering:wagering@127.0.0.1:1/wagering",
    });

    const ready = await fetch(`${url}/health/ready`);
    const live = await fetch(`${url}/health/live`);

    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      status: "unavailable",
      checks: { postgres: "down", sqs: "up" },
    });
    expect(live.status).toBe(200);
  });
});
