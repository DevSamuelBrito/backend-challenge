import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { Repositories } from "../../src/shared/application/unit-of-work.port";
import { createGate, type Gate, waitUntilSomeoneWaitsOnLock } from "../support/async";
import type { HttpResult } from "../support/http";
import { expectInvariants } from "../support/invariants";
import { tableCounts } from "../support/table-counts";
import {
  keyFor,
  openWallet,
  submit,
  transactionsOf,
  wagerPayload,
  walletSnapshot,
} from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

async function holdRowLock(api: WalletApi, walletId: string) {
  const holder: Client = await api.db.connect();
  await holder.query("begin");
  await holder.query("select id from wallets where id = $1 for update", [walletId]);

  return {
    release: async () => {
      await holder.query("rollback");
    },
  };
}

describe("lock por wallet visto pela API: timeout e independência entre wallets", () => {
  describe("lock_timeout curto", () => {
    let api: WalletApi;

    beforeAll(async () => {
      api = await startWalletApi({ lockTimeoutMs: 300 });
    });

    afterAll(async () => {
      await api.close();
    });

    afterEach(async () => {
      await expectInvariants(api.db.client);
    });

    test("wallet travada por outra transação: 503 LOCK_TIMEOUT com Retry-After, nada persistido e o retry funciona", async () => {
      const wallet = await openWallet(api.http, "100.00");
      const payload = wagerPayload(wallet);
      const key = keyFor(payload);
      const lock = await holdRowLock(api, wallet.id);
      const before = await tableCounts(api.db.client);

      const startedAt = performance.now();
      const blocked = await submit(api.http, payload, key);
      const waitedMs = performance.now() - startedAt;

      expect(blocked.status).toBe(503);
      expect(blocked.body).toEqual({ code: "LOCK_TIMEOUT", message: expect.any(String) });
      expect(blocked.headers.get("retry-after")).toBe("1");
      expect(waitedMs).toBeGreaterThanOrEqual(290);
      expect(await tableCounts(api.db.client)).toEqual(before);

      await lock.release();
      const retried = await submit(api.http, payload, key);

      expect(retried.status).toBe(200);
      expect(retried.body).toMatchObject({ status: "PROCESSED", idempotentReplay: false });
      expect(await walletSnapshot(api.db.client, wallet.id)).toEqual({
        balance: "90.00",
        version: 2,
      });
      expect(await transactionsOf(api.db.client, wallet.id)).toHaveLength(1);
    });

    test("o 503 não afeta outras wallets, que seguem respondendo normalmente", async () => {
      const locked = await openWallet(api.http, "100.00");
      const free = await openWallet(api.http, "100.00");
      const lock = await holdRowLock(api, locked.id);

      const [blocked, ok] = await Promise.all([
        submit(api.http, wagerPayload(locked), "k-locked"),
        submit(api.http, wagerPayload(free), "k-free"),
      ]);
      await lock.release();

      expect(blocked.status).toBe(503);
      expect(ok.status).toBe(200);
    });
  });

  describe("lock_timeout padrão", () => {
    let api: WalletApi;

    beforeAll(async () => {
      api = await startWalletApi();
    });

    afterAll(async () => {
      await api.close();
    });

    afterEach(async () => {
      await expectInvariants(api.db.client);
    });

    test("wallets diferentes não se bloqueiam, e a travada só prossegue depois que o lock é solto", async () => {
      const locked = await openWallet(api.http, "100.00");
      const free = await openWallet(api.http, "100.00");
      const lock = await holdRowLock(api, locked.id);

      let lockedSettled = false;
      const lockedRequest: Promise<HttpResult> = submit(
        api.http,
        wagerPayload(locked),
        "k-locked",
      ).then((response) => {
        lockedSettled = true;
        return response;
      });

      await waitUntilSomeoneWaitsOnLock(api.db.client);

      const freeResponse = await submit(api.http, wagerPayload(free), "k-free");

      expect(freeResponse.status).toBe(200);
      expect(lockedSettled).toBe(false);

      await lock.release();
      const lockedResponse = await lockedRequest;

      expect(lockedResponse.status).toBe(200);
      expect(lockedResponse.body).toMatchObject({
        status: "PROCESSED",
        balance: { amount: "90.00" },
      });
    });

    test("a segunda requisição da mesma wallet espera a primeira terminar e enxerga o resultado dela", async () => {
      const wallet = await openWallet(api.http, "100.00");
      const first = wagerPayload(wallet, { money: { amount: "80.00", currency: "BRL" } });
      const second = wagerPayload(wallet, { money: { amount: "80.00", currency: "BRL" } });
      const lock = await holdRowLock(api, wallet.id);

      const requests = [
        submit(api.http, first, keyFor(first)),
        submit(api.http, second, keyFor(second)),
      ];

      await waitUntilSomeoneWaitsOnLock(api.db.client, 2);
      await lock.release();
      const responses = await Promise.all(requests);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
      expect(await walletSnapshot(api.db.client, wallet.id)).toEqual({
        balance: "20.00",
        version: 2,
      });
    });
  });
});

describe("a idempotência é decidida DEPOIS do lock, sem fast path e sem retry desnecessário", () => {
  let api: WalletApi;
  let runs = 0;
  let barrier: { parties: number; arrived: number; gate: Gate } | undefined;

  const arriveAtBarrier = async () => {
    if (!barrier) {
      return;
    }

    barrier.arrived += 1;
    if (barrier.arrived >= barrier.parties) {
      barrier.gate.open();
    }
    await barrier.gate.opened;
  };

  const withBarrier = (repositories: Repositories): Repositories => {
    const { transactions } = repositories;

    return {
      ...repositories,
      transactions: {
        add: async (transaction) => {
          await arriveAtBarrier();
          return transactions.add(transaction);
        },
        save: (transaction) => transactions.save(transaction),
        findById: (id) => transactions.findById(id),
        findByIdempotencyKey: (key) => transactions.findByIdempotencyKey(key),
        findByProviderAndExternalId: (provider, externalId) =>
          transactions.findByProviderAndExternalId(provider, externalId),
        hasProcessedReversalOf: (id) => transactions.hasProcessedReversalOf(id),
        findDueForReference: (now, limit) => transactions.findDueForReference(now, limit),
      },
    };
  };

  beforeAll(async () => {
    api = await startWalletApi({
      lockTimeoutMs: 400,
      wrapUnitOfWork: (real) => ({
        run: (work) => {
          runs += 1;
          return real.run((repositories) =>
            work(barrier ? withBarrier(repositories) : repositories),
          );
        },
      }),
    });
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(async () => {
    await expectInvariants(api.db.client);
  });

  test("um replay de transação já commitada também espera o lock da wallet (sem fast path): com a wallet travada, dá 503", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const payload = wagerPayload(wallet);
    const key = keyFor(payload);
    const first = await submit(api.http, payload, key);
    const lock = await holdRowLock(api, wallet.id);

    const replay = await submit(api.http, payload, key);
    await lock.release();

    expect(first.status).toBe(200);
    expect(replay.status).toBe(503);
    expect(replay.body).toMatchObject({ code: "LOCK_TIMEOUT" });
  });

  test("duas requisições idênticas esperando o mesmo lock: uma executa, a outra vira replay, e nenhuma precisa de retry", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const payload = wagerPayload(wallet);
    const key = keyFor(payload);
    const lock = await holdRowLock(api, wallet.id);
    const runsBefore = runs;

    const pending = [submit(api.http, payload, key), submit(api.http, payload, key)];
    await waitUntilSomeoneWaitsOnLock(api.db.client, 2);
    await lock.release();
    const responses = await Promise.all(pending);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      responses
        .map((response) => (response.body as { idempotentReplay: boolean }).idempotentReplay)
        .sort(),
    ).toEqual([false, true]);
    expect(runs - runsBefore).toBe(2);
    expect(await walletSnapshot(api.db.client, wallet.id)).toEqual({
      balance: "90.00",
      version: 2,
    });
  });

  test("casos sequenciais (novo, replay, conflito de hash, conflito externo) resolvem numa única transação cada, sem retry", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const payload = wagerPayload(wallet);
    const key = keyFor(payload);

    const measured = async (request: () => Promise<HttpResult>) => {
      const before = runs;
      const response = await request();
      return { response, runs: runs - before };
    };

    const created = await measured(() => submit(api.http, payload, key));
    const replayed = await measured(() => submit(api.http, payload, key));
    const hashConflict = await measured(() =>
      submit(api.http, { ...payload, money: { amount: "11.00", currency: "BRL" } }, key),
    );
    const externalConflict = await measured(() => submit(api.http, payload, "outra-chave"));

    expect([created.response.status, created.runs]).toEqual([200, 1]);
    expect([replayed.response.status, replayed.runs]).toEqual([200, 1]);
    expect([hashConflict.response.status, hashConflict.runs]).toEqual([409, 1]);
    expect([externalConflict.response.status, externalConflict.runs]).toEqual([409, 1]);
  });

  test("mesma chave em wallets diferentes ao mesmo tempo: o perdedor refaz a leitura numa transação NOVA, uma única vez", async () => {
    const first = await openWallet(api.http, "100.00");
    const second = await openWallet(api.http, "100.00");
    const runsBefore = runs;
    barrier = { parties: 2, arrived: 0, gate: createGate() };

    const responses = await Promise.all([
      submit(api.http, wagerPayload(first), "chave-corrida"),
      submit(api.http, wagerPayload(second), "chave-corrida"),
    ]);
    barrier = undefined;

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(runs - runsBefore).toBe(3);
  });
});
