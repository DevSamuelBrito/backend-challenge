import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { Logger, UnauthorizedException } from "@nestjs/common";
import type { Client } from "pg";
import { PROVIDER_IDENTITY } from "../../src/modules/auth/provider-identity.port";
import { EVENT_PUBLISHER } from "../../src/modules/messaging/application/event-publisher.port";
import { CLOCK } from "../../src/shared/application/clock.port";
import { ControlledClock } from "../support/doubles";
import { expectInvariants } from "../support/invariants";
import { ALL_METRIC_NAMES, metricValue, scrape } from "../support/observability";
import { AT, outboxPublisherOf } from "../support/outbox";
import { workerOf } from "../support/pending-worker";
import {
  type OpenedWallet,
  openWallet,
  submitWithDefaultKey,
  type WagerPayload,
  wagerPayload,
} from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

const money = (amount: string) => ({ amount, currency: "BRL" });

describe("GET /metrics e os contadores do fluxo HTTP", () => {
  let api: WalletApi;
  const clock = new ControlledClock(AT);
  const publisher = { failing: false };

  beforeAll(async () => {
    api = await startWalletApi({
      lockTimeoutMs: 400,
      providers: [
        { token: CLOCK, value: clock },
        {
          token: EVENT_PUBLISHER,
          value: {
            publish: async (events: { eventId: string }[]) =>
              events.map((event) =>
                publisher.failing
                  ? { eventId: event.eventId, confirmed: false, reason: "SQS fora" }
                  : { eventId: event.eventId, confirmed: true },
              ),
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(() => {
    clock.set(AT);
    publisher.failing = false;
  });

  afterEach(async () => {
    await expectInvariants(api.db.client);
  });

  const metrics = () => scrape(api.http);

  const place = async (wallet: OpenedWallet, overrides: Partial<WagerPayload> = {}) => {
    const payload = wagerPayload(wallet, overrides);
    const result = await submitWithDefaultKey(api.http, payload);

    return { payload, result };
  };

  test("responde 200 em texto Prometheus e expõe todas as métricas do enunciado", async () => {
    const result = await api.http.get("/metrics");

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/plain");
    for (const name of ALL_METRIC_NAMES) {
      expect(result.body as string).toContain(`# TYPE ${name} `);
    }
  });

  test("não passa pelo AuthGuard: continua respondendo mesmo quando a identidade barra tudo", async () => {
    const guarded = await startWalletApi({
      providers: [
        {
          token: PROVIDER_IDENTITY,
          value: {
            identify: async () => {
              throw new UnauthorizedException();
            },
          },
        },
      ],
    });

    try {
      expect((await guarded.http.get("/metrics")).status).toBe(200);
      expect((await guarded.http.get("/wallets/00000000-0000-0000-0000-000000000000")).status).toBe(
        401,
      );
    } finally {
      await guarded.close();
    }
  });

  test("com as métricas default ligadas, expõe também as do processo", async () => {
    const withDefaults = await startWalletApi({ env: { METRICS_DEFAULT_METRICS: "true" } });

    try {
      const text = await scrape(withDefaults.http);

      expect(text).toContain("process_cpu_user_seconds_total");
      expect(text).toContain("nodejs_eventloop_lag_seconds");
    } finally {
      await withDefaults.close();
    }
  });

  test("uma BET processada soma em transações por kind e status e na latência HTTP", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const before = await metrics();

    const { result } = await place(wallet, { money: money("10.00") });
    const after = await metrics();

    expect(result.status).toBe(200);
    expect(
      metricValue(after, "wager_transactions_total", { kind: "BET", status: "PROCESSED" }) -
        metricValue(before, "wager_transactions_total", { kind: "BET", status: "PROCESSED" }),
    ).toBe(1);
    expect(
      metricValue(after, "wager_processing_duration_seconds_count", { source: "http" }) -
        metricValue(before, "wager_processing_duration_seconds_count", { source: "http" }),
    ).toBe(1);
    expect(
      metricValue(after, "wager_wallet_lock_wait_seconds_count") -
        metricValue(before, "wager_wallet_lock_wait_seconds_count"),
    ).toBe(1);
  });

  test("uma transação REJECTED soma com o status REJECTED", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const before = await metrics();

    const { result } = await place(wallet, { money: money("500.00") });
    const after = await metrics();

    expect(result.status).toBe(422);
    expect(
      metricValue(after, "wager_transactions_total", { kind: "BET", status: "REJECTED" }) -
        metricValue(before, "wager_transactions_total", { kind: "BET", status: "REJECTED" }),
    ).toBe(1);
  });

  test("um replay de idempotência soma em duplicatas e não em transações", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const { payload } = await place(wallet, { money: money("10.00") });
    const before = await metrics();

    const replay = await submitWithDefaultKey(api.http, payload);
    const after = await metrics();

    expect((replay.body as { idempotentReplay: boolean }).idempotentReplay).toBe(true);
    expect(
      metricValue(after, "wager_duplicates_total", { type: "idempotent_replay", source: "http" }) -
        metricValue(before, "wager_duplicates_total", {
          type: "idempotent_replay",
          source: "http",
        }),
    ).toBe(1);
    expect(metricValue(after, "wager_transactions_total", { kind: "BET" })).toBe(
      metricValue(before, "wager_transactions_total", { kind: "BET" }),
    );
  });

  test("uma pendência soma PENDING_REFERENCE e, ao ser reavaliada sem resolver, um retry do worker", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const before = await metrics();

    const { result } = await place(wallet, {
      kind: "ROLLBACK",
      money: money("10.00"),
      referenceExternalTransactionId: "ainda-nao-chegou",
    });
    expect(result.status).toBe(202);
    const pending = await metrics();

    clock.advance(2000);
    const report = await workerOf(api).tick(clock.now());
    const after = await metrics();

    expect(report.rescheduled).toBe(1);
    expect(
      metricValue(pending, "wager_transactions_total", {
        kind: "ROLLBACK",
        status: "PENDING_REFERENCE",
      }) -
        metricValue(before, "wager_transactions_total", {
          kind: "ROLLBACK",
          status: "PENDING_REFERENCE",
        }),
    ).toBe(1);
    expect(
      metricValue(after, "wager_retries_total", { source: "pending_worker" }) -
        metricValue(pending, "wager_retries_total", { source: "pending_worker" }),
    ).toBe(1);
    expect(
      metricValue(after, "wager_processing_duration_seconds_count", { source: "worker" }) -
        metricValue(pending, "wager_processing_duration_seconds_count", { source: "worker" }),
    ).toBe(1);
  });

  test("a referência que chega depois: o worker conta a transação PROCESSED", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const bet = wagerPayload(wallet, { money: money("10.00") });
    await place(wallet, {
      kind: "REFUND",
      money: money("10.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await submitWithDefaultKey(api.http, bet);
    const before = await metrics();

    clock.advance(2000);
    await workerOf(api).tick(clock.now());
    const after = await metrics();

    expect(
      metricValue(after, "wager_transactions_total", { kind: "REFUND", status: "PROCESSED" }) -
        metricValue(before, "wager_transactions_total", { kind: "REFUND", status: "PROCESSED" }),
    ).toBe(1);
  });

  describe("lock timeout", () => {
    let holder: Client | undefined;

    afterEach(async () => {
      await holder?.query("rollback").catch(() => undefined);
      await holder?.end().catch(() => undefined);
      holder = undefined;
    });

    test("quem estoura o lock_timeout soma em conflitos de lock e recebe 503", async () => {
      const wallet = await openWallet(api.http, "100.00");
      holder = await api.db.connect();
      await holder.query("begin");
      await holder.query("select id from wallets where id = $1 for update", [wallet.id]);
      const before = await metrics();

      const { result } = await place(wallet, { money: money("10.00") });
      const after = await metrics();

      expect(result.status).toBe(503);
      expect(
        metricValue(after, "wager_lock_timeouts_total") -
          metricValue(before, "wager_lock_timeouts_total"),
      ).toBe(1);
      expect(
        metricValue(after, "wager_wallet_lock_wait_seconds_sum") -
          metricValue(before, "wager_wallet_lock_wait_seconds_sum"),
      ).toBeGreaterThan(0.3);
    });
  });

  test("uma divergência de reconciliação soma no contador, e uma consistente não", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const before = await metrics();
    await api.http.post(`/wallets/${wallet.id}/reconciliation`, {});
    const consistent = await metrics();
    const error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    try {
      await api.db.client.query("update wallets set balance = 7.00 where id = $1", [wallet.id]);
      await api.http.post(`/wallets/${wallet.id}/reconciliation`, {});
    } finally {
      error.mockRestore();
      await api.db.client.query("update wallets set balance = 100.00 where id = $1", [wallet.id]);
    }
    const after = await metrics();

    expect(metricValue(consistent, "wager_reconciliation_mismatches_total")).toBe(
      metricValue(before, "wager_reconciliation_mismatches_total"),
    );
    expect(
      metricValue(after, "wager_reconciliation_mismatches_total") -
        metricValue(consistent, "wager_reconciliation_mismatches_total"),
    ).toBe(1);
  });

  describe("outbox", () => {
    beforeEach(async () => {
      await api.db.client.query(
        "update outbox_messages set published_at = now() where published_at is null",
      );
    });

    test("falha de envio soma retries da outbox por mensagem, e o lag sobe com pendentes e volta a 0 ao publicar", async () => {
      const wallet = await openWallet(api.http, "100.00");
      await place(wallet, { money: money("10.00") });
      const { rows } = await api.db.client.query(
        "select count(*)::int as total from outbox_messages where published_at is null",
      );
      const pending = rows[0].total as number;
      const before = await metrics();
      publisher.failing = true;

      await outboxPublisherOf(api).tick(new Date(AT.getTime() + 30_000));
      const failed = await metrics();

      expect(pending).toBeGreaterThan(0);
      expect(
        metricValue(failed, "wager_retries_total", { source: "outbox" }) -
          metricValue(before, "wager_retries_total", { source: "outbox" }),
      ).toBe(pending);
      expect(metricValue(failed, "wager_outbox_lag_seconds")).toBeCloseTo(30, 0);

      publisher.failing = false;
      await outboxPublisherOf(api).tick(new Date(AT.getTime() + 60_000));
      const published = await metrics();

      expect(metricValue(published, "wager_outbox_lag_seconds")).toBe(0);
    });

    test("sem nenhuma pendente o lag é 0", async () => {
      await outboxPublisherOf(api).tick(new Date(AT.getTime() + 5000));

      expect(metricValue(await metrics(), "wager_outbox_lag_seconds")).toBe(0);
    });

    test("o lag é a idade da mais antiga pendente, e não é calculado a cada scrape", async () => {
      const wallet = await openWallet(api.http, "100.00");
      publisher.failing = true;
      await outboxPublisherOf(api).tick(new Date(AT.getTime() + 10_000));
      const first = metricValue(await metrics(), "wager_outbox_lag_seconds");

      const second = metricValue(await metrics(), "wager_outbox_lag_seconds");

      expect(wallet.id).toBeDefined();
      expect(first).toBeCloseTo(10, 0);
      expect(second).toBe(first);
    });
  });
});
