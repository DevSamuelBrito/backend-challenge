import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EVENT_PUBLISHER } from "../../src/modules/messaging/application/event-publisher.port";
import { CLOCK } from "../../src/shared/application/clock.port";
import { validCorrelationId } from "../../src/shared/application/correlation-id";
import { ControlledClock } from "../support/doubles";
import { expectInvariants } from "../support/invariants";
import { LogCapture, logProvider } from "../support/observability";
import { AT, outboxPublisherOf } from "../support/outbox";
import { workerOf } from "../support/pending-worker";
import {
  eventsOfTransaction,
  type OpenedWallet,
  openWallet,
  submit,
  type WagerPayload,
  wagerPayload,
} from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

const money = (amount: string) => ({ amount, currency: "BRL" });

describe("correlação e logs no fluxo HTTP", () => {
  const capture = new LogCapture();
  const clock = new ControlledClock(AT);
  const publisher = { failing: false };
  let api: WalletApi;

  beforeAll(async () => {
    api = await startWalletApi({
      useAppLogger: true,
      env: { OUTBOX_ALERT_ATTEMPTS: "1" },
      providers: [
        logProvider(capture),
        { token: CLOCK, value: clock },
        {
          token: EVENT_PUBLISHER,
          value: {
            publish: async (events: { eventId: string }[]) =>
              events.map((event) => ({
                eventId: event.eventId,
                confirmed: !publisher.failing,
                reason: "SQS fora",
              })),
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(async () => {
    await api.db.client.query(
      "update outbox_messages set published_at = now() where published_at is null",
    );
    capture.clear();
    clock.set(AT);
    publisher.failing = false;
  });

  afterEach(async () => {
    await expectInvariants(api.db.client);
  });

  const bet = async (
    wallet: OpenedWallet,
    headers: Record<string, string> = {},
    overrides: Partial<WagerPayload> = {},
  ) => {
    const payload = wagerPayload(wallet, { money: money("10.00"), ...overrides });
    const key = `${payload.providerId}:${payload.externalTransactionId}`;
    const result = await api.http.post("/wagering/transactions", payload, {
      "Idempotency-Key": key,
      ...headers,
    });

    return { payload, key, result };
  };

  const correlationOf = async (transactionId: string) =>
    (await eventsOfTransaction(api.db.client, transactionId)).map(
      (event) => (event.payload as unknown as { correlationId: string }).correlationId,
    );

  test("o X-Correlation-Id enviado volta na resposta, entra nos logs e nos eventos da outbox", async () => {
    const wallet = await openWallet(api.http, "100.00");
    capture.clear();

    const { result, key } = await bet(wallet, { "X-Correlation-Id": "req-abc-123" });
    const { transactionId } = result.body as { transactionId: string };

    expect(result.headers.get("x-correlation-id")).toBe("req-abc-123");
    expect(new Set(await correlationOf(transactionId))).toEqual(new Set(["req-abc-123"]));
    const events = await eventsOfTransaction(api.db.client, transactionId);
    expect(events.every((event) => event.payload.causationId === key)).toBe(true);

    const processed = capture.events("wager.processed")[0];
    expect(processed).toMatchObject({
      correlationId: "req-abc-123",
      walletId: wallet.id,
      providerId: "provider-a",
      transactionId,
      kind: "BET",
      status: "PROCESSED",
      source: "http",
    });
    expect(capture.events("http.request")[0]).toMatchObject({
      correlationId: "req-abc-123",
      method: "POST",
      path: "/wagering/transactions",
      statusCode: 200,
    });
  });

  test.each([
    ["com espaço"],
    ["x".repeat(129)],
    ["a,b"],
    ["acentuação"],
    ["<script>"],
    ["-começa-com-hífen"],
  ])("X-Correlation-Id inválido (%j) é descartado e um novo é gerado", async (invalid) => {
    const wallet = await openWallet(api.http, "100.00");

    const { result } = await bet(wallet, { "X-Correlation-Id": invalid }).catch(() => ({
      result: undefined,
    }));

    if (!result) {
      return;
    }

    const generated = result.headers.get("x-correlation-id") as string;
    const { transactionId } = result.body as { transactionId: string };
    expect(generated).not.toBe(invalid);
    expect(validCorrelationId(generated)).toBe(generated);
    expect(new Set(await correlationOf(transactionId))).toEqual(new Set([generated]));
  });

  test("sem o header, gera um novo por requisição", async () => {
    const wallet = await openWallet(api.http, "100.00");

    const first = (await bet(wallet)).result.headers.get("x-correlation-id");
    const second = (await bet(wallet)).result.headers.get("x-correlation-id");

    expect(validCorrelationId(first)).toBe(first as string);
    expect(validCorrelationId(second)).toBe(second as string);
    expect(first).not.toBe(second);
  });

  test("toda resposta devolve o header, inclusive erros e a leitura", async () => {
    const notFound = await api.http.get(`/wagering/transactions/${randomUUID()}`);
    const invalid = await api.http.post("/wagering/transactions", {}, {});

    expect(notFound.headers.get("x-correlation-id")).toBeTruthy();
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("x-correlation-id")).toBeTruthy();
  });

  test("a abertura de wallet também usa o correlationId da requisição nos eventos", async () => {
    const result = await api.http.post(
      "/wallets",
      { playerId: `player-${randomUUID()}`, initialBalance: money("50.00") },
      { "X-Correlation-Id": "wallet-open-1" },
    );
    const { id } = result.body as { id: string };

    const { rows } = await api.db.client.query(
      "select distinct payload ->> 'correlationId' as correlation_id from outbox_messages where payload -> 'data' ->> 'walletId' = $1",
      [id],
    );

    expect(rows).toEqual([{ correlation_id: "wallet-open-1" }]);
    expect(
      capture.events("http.request").some((line) => line.correlationId === "wallet-open-1"),
    ).toBe(true);
  });

  test("as linhas de log são JSON com os campos do contexto e o /health e /metrics não geram access log", async () => {
    await api.http.get("/health/live");
    await api.http.get("/metrics");
    const wallet = await openWallet(api.http, "100.00");

    expect(capture.events("http.request").map((line) => line.path)).toEqual(["/wallets"]);
    expect(capture.lines.every((line) => typeof line.time === "string")).toBe(true);
    expect(wallet.id).toBeDefined();
  });

  test("o replay é logado como wager.replay com os mesmos campos de correlação", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const { payload, key } = await bet(wallet);
    capture.clear();

    await api.http.post("/wagering/transactions", payload, {
      "Idempotency-Key": key,
      "X-Correlation-Id": "replay-1",
    });

    expect(capture.events("wager.replay")[0]).toMatchObject({
      correlationId: "replay-1",
      walletId: wallet.id,
      kind: "BET",
      status: "PROCESSED",
    });
  });

  test("worker de pendências: contexto próprio por candidata, com ids nos logs e nos eventos", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const original = wagerPayload(wallet, { money: money("10.00") });
    const pending = await api.http.post(
      "/wagering/transactions",
      wagerPayload(wallet, {
        kind: "REFUND",
        money: money("10.00"),
        referenceExternalTransactionId: original.externalTransactionId,
      }),
      { "Idempotency-Key": `k-${randomUUID()}`, "X-Correlation-Id": "pendente-1" },
    );
    const { transactionId } = pending.body as { transactionId: string };
    await submit(api.http, original, `${original.providerId}:${original.externalTransactionId}`);
    capture.clear();

    clock.advance(2000);
    await workerOf(api).tick(clock.now());

    const resolved = capture.events("pending_worker.processed")[0];
    expect(resolved).toMatchObject({
      transactionId,
      walletId: wallet.id,
      providerId: "provider-a",
    });
    const workerCorrelation = resolved?.correlationId as string;
    expect(validCorrelationId(workerCorrelation)).toBe(workerCorrelation);
    expect(workerCorrelation).not.toBe("pendente-1");
    const events = await correlationOf(transactionId);
    expect(events).toContain("pendente-1");
    expect(events).toContain(workerCorrelation);
  });

  test("publisher da outbox: contexto por tick e o aviso de atraso carrega o correlationId do evento", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const { result } = await bet(wallet, { "X-Correlation-Id": "atrasado-1" });
    const { transactionId } = result.body as { transactionId: string };
    publisher.failing = true;
    capture.clear();

    await outboxPublisherOf(api).tick(new Date(AT.getTime() + 5_000));
    await outboxPublisherOf(api).tick(new Date(AT.getTime() + 20_000));

    const late = capture
      .events("outbox.publish_late")
      .filter((line) => line.transactionId === transactionId);
    expect(late.length).toBeGreaterThan(0);
    expect(late[0]).toMatchObject({
      correlationId: "atrasado-1",
      walletId: wallet.id,
      attempts: 2,
      reason: "SQS fora",
    });
  });
});
