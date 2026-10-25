import { afterEach, describe, expect, test } from "bun:test";
import { PendingReferenceWorker } from "../../src/modules/wagering/application/pending-reference-worker";
import { createGate, waitUntil } from "../support/async";
import { expectInvariants } from "../support/invariants";
import { rowOf } from "../support/pending-worker";
import { openWallet, submitWithDefaultKey, wagerPayload } from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

const money = (amount: string) => ({ amount, currency: "BRL" });

describe("agendador do worker de PENDING_REFERENCE dentro da aplicação Nest", () => {
  let api: WalletApi | undefined;

  afterEach(async () => {
    if (api) {
      await expectInvariants(api.db.client);
      await api.close().catch(() => undefined);
      api = undefined;
    }
  });

  test("com o papel pending-worker, a aplicação resolve sozinha a pendência quando a referência chega", async () => {
    api = await startWalletApi({
      env: { APP_ROLES: "api,pending-worker", PENDING_WORKER_INTERVAL_MS: "50" },
    });
    const target = await openWallet(api.http, "100.00");
    const original = wagerPayload(target, { kind: "BET", money: money("25.00") });
    const refund = await submitWithDefaultKey(
      api.http,
      wagerPayload(target, {
        kind: "REFUND",
        referenceExternalTransactionId: original.externalTransactionId,
        money: money("25.00"),
      }),
    );
    expect(refund.status).toBe(202);
    expect((await submitWithDefaultKey(api.http, original)).status).toBe(200);
    const { transactionId } = refund.body as { transactionId: string };
    const client = api.db.client;

    await waitUntil(
      async () => (await rowOf(client, transactionId)).status === "PROCESSED",
      "o agendador resolver a pendência",
      15_000,
    );

    const { rows } = await client.query(
      "select balance::text as balance from wallets where id = $1",
      [target.id],
    );
    expect(rows[0]).toEqual({ balance: "100.00" });
  });

  test("sem o papel pending-worker, nenhum tick é agendado", async () => {
    api = await startWalletApi({
      env: { APP_ROLES: "api", PENDING_WORKER_INTERVAL_MS: "20" },
    });
    const worker = api.app.get(PendingReferenceWorker, { strict: false });
    let ticks = 0;
    const original = worker.tick.bind(worker);
    worker.tick = (now) => {
      ticks += 1;
      return original(now);
    };

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(ticks).toBe(0);
  });

  test("o shutdown da aplicação espera o tick em andamento terminar", async () => {
    api = await startWalletApi({
      env: { APP_ROLES: "api,pending-worker", PENDING_WORKER_INTERVAL_MS: "10" },
    });
    const worker = api.app.get(PendingReferenceWorker, { strict: false });
    const original = worker.tick.bind(worker);
    const release = createGate();
    let started = false;
    let finished = false;
    worker.tick = async (now) => {
      started = true;
      await release.opened;
      const report = await original(now);
      finished = true;
      return report;
    };

    await waitUntil(() => started, "um tick começar");
    let closed = false;
    const closing = api.app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(closed).toBe(false);

    release.open();
    await closing;

    expect(finished).toBe(true);
    expect(closed).toBe(true);
    await api.db.close();
    api = undefined;
  });
});
