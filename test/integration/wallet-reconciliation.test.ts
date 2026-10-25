import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { waitUntilSomeoneWaitsOnLock } from "../support/async";
import { holdingUnitOfWork } from "../support/hold";
import { expectInvariants } from "../support/invariants";
import {
  type OpenedWallet,
  openWallet,
  submitWithDefaultKey,
  type WagerPayload,
  wagerPayload,
  walletSnapshot,
} from "../support/wagering-api";
import { type Cluster, startCluster, startWalletApi, type WalletApi } from "../support/wallet-api";

const money = (amount: string, currency = "BRL") => ({ amount, currency });

interface Reconciliation {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

const holder = holdingUnitOfWork();

describe("POST /wallets/:walletId/reconciliation", () => {
  let api: WalletApi;

  beforeAll(async () => {
    api = await startWalletApi({ wrapUnitOfWork: holder.wrap });
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(async () => {
    await expectInvariants(api.db.client);
  });

  const reconcile = (walletId: string) => api.http.post(`/wallets/${walletId}/reconciliation`, {});

  const send = async (wallet: OpenedWallet, overrides: Partial<WagerPayload>) => {
    const payload = wagerPayload(wallet, overrides);
    const result = await submitWithDefaultKey(api.http, payload);
    expect(result.status).toBe(200);

    return payload;
  };

  test("wallet consistente depois de BET, WIN, REFUND e ROLLBACK: consistent true, diferença 0.00 e contagem certa", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const betA = await send(wallet, { money: money("30.00") });
    const win = await send(wallet, {
      kind: "WIN",
      money: money("50.00"),
      referenceExternalTransactionId: betA.externalTransactionId,
    });
    const betB = await send(wallet, { money: money("20.00") });
    await send(wallet, {
      kind: "REFUND",
      money: money("20.00"),
      referenceExternalTransactionId: betB.externalTransactionId,
    });
    await send(wallet, {
      kind: "ROLLBACK",
      money: money("50.00"),
      referenceExternalTransactionId: win.externalTransactionId,
    });

    const result = await reconcile(wallet.id);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      walletId: wallet.id,
      storedBalance: money("70.00"),
      calculatedBalance: money("70.00"),
      difference: money("0.00"),
      consistent: true,
      checkedEntries: 6,
    });
  });

  test("wallet sem lançamentos: tudo zero, consistente e 0 lançamentos", async () => {
    const wallet = await openWallet(api.http, "0.00");

    const result = await reconcile(wallet.id);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      walletId: wallet.id,
      storedBalance: money("0.00"),
      calculatedBalance: money("0.00"),
      difference: money("0.00"),
      consistent: true,
      checkedEntries: 0,
    });
  });

  test("a moeda da resposta é a da wallet", async () => {
    const wallet = await openWallet(api.http, "10.00", "USD");

    const result = await reconcile(wallet.id);

    expect(result.body).toMatchObject({
      storedBalance: money("10.00", "USD"),
      calculatedBalance: money("10.00", "USD"),
      difference: money("0.00", "USD"),
    });
  });

  test("é somente leitura: não cria nem altera nada", async () => {
    const wallet = await openWallet(api.http, "100.00");
    await send(wallet, { money: money("30.00") });
    const counts = () =>
      api.db.client.query(
        "select (select count(*) from wager_transactions) t, (select count(*) from outbox_messages) o, (select count(*) from wallet_ledger_entries) l, (select version from wallets where id = $1) v, (select updated_at from wallets where id = $1) u",
        [wallet.id],
      );
    const before = await counts();

    await reconcile(wallet.id);
    await reconcile(wallet.id);

    expect((await counts()).rows).toEqual(before.rows);
  });

  test("divergência forçada: consistent false, diferença correta, log de erro estruturado e saldo NÃO corrigido", async () => {
    const wallet = await openWallet(api.http, "100.00");
    await send(wallet, { money: money("30.00") });
    const error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    try {
      await api.db.client.query("update wallets set balance = 120.00 where id = $1", [wallet.id]);

      const result = await reconcile(wallet.id);

      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        walletId: wallet.id,
        storedBalance: money("120.00"),
        calculatedBalance: money("70.00"),
        difference: money("50.00"),
        consistent: false,
        checkedEntries: 2,
      });
      expect(await walletSnapshot(api.db.client, wallet.id)).toEqual({
        balance: "120.00",
        version: 2,
      });
      const logged = error.mock.calls.map((call) => call[0] as Record<string, unknown>);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toEqual({
        event: "wallet.reconciliation_mismatch",
        walletId: wallet.id,
        storedIs: "ABOVE_LEDGER",
        checkedEntries: 2,
      });

      const again = await reconcile(wallet.id);

      expect((again.body as Reconciliation).consistent).toBe(false);
      expect(await walletSnapshot(api.db.client, wallet.id)).toMatchObject({ balance: "120.00" });
    } finally {
      error.mockRestore();
      await api.db.client.query("update wallets set balance = 70.00 where id = $1", [wallet.id]);
    }
  });

  test("divergência para menos: a diferença é negativa", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    try {
      await api.db.client.query("update wallets set balance = 40.00 where id = $1", [wallet.id]);

      const result = await reconcile(wallet.id);

      expect(result.body).toMatchObject({
        storedBalance: money("40.00"),
        calculatedBalance: money("100.00"),
        difference: money("-60.00"),
        consistent: false,
      });
    } finally {
      error.mockRestore();
      await api.db.client.query("update wallets set balance = 100.00 where id = $1", [wallet.id]);
    }
  });

  test("consistente não gera log de erro", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    try {
      await reconcile(wallet.id);

      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("404 para wallet inexistente e 400 para id malformado", async () => {
    const missing = await reconcile(randomUUID());
    const malformed = await reconcile("nao-e-uuid");

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "WALLET_NOT_FOUND" });
    expect(malformed.status).toBe(400);
  });

  test("valores acima de Number.MAX_SAFE_INTEGER passam intactos", async () => {
    const wallet = await openWallet(api.http, "9007199254740993.00");
    await send(wallet, { money: money("1.01") });

    const result = await reconcile(wallet.id);

    expect(result.body).toEqual({
      walletId: wallet.id,
      storedBalance: money("9007199254740991.99"),
      calculatedBalance: money("9007199254740991.99"),
      difference: money("0.00"),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("FOR SHARE: enquanto a reconciliação segura a wallet, uma escrita concorrente espera e só depois grava", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const hold = holder.holdNext();
    const reconciling = reconcile(wallet.id);
    await hold.reached;

    let betAnswered = false;
    const betting = submitWithDefaultKey(
      api.http,
      wagerPayload(wallet, { money: money("30.00") }),
    ).then((result) => {
      betAnswered = true;
      return result;
    });
    await waitUntilSomeoneWaitsOnLock(api.db.client);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(betAnswered).toBe(false);
    expect((await walletSnapshot(api.db.client, wallet.id)).balance).toBe("100.00");

    hold.release("commit");
    const reconciled = await reconciling;
    const bet = await betting;

    expect(reconciled.body).toMatchObject({
      storedBalance: money("100.00"),
      calculatedBalance: money("100.00"),
      consistent: true,
      checkedEntries: 1,
    });
    expect(bet.status).toBe(200);
    expect((await walletSnapshot(api.db.client, wallet.id)).balance).toBe("70.00");
  });

  test("a reconciliação espera uma escrita em andamento e enxerga o resultado dela, já consistente", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const hold = holder.holdNext();
    const betting = submitWithDefaultKey(api.http, wagerPayload(wallet, { money: money("30.00") }));
    await hold.reached;

    let reconciled = false;
    const reconciling = reconcile(wallet.id).then((result) => {
      reconciled = true;
      return result;
    });
    await waitUntilSomeoneWaitsOnLock(api.db.client);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(reconciled).toBe(false);

    hold.release("commit");
    await betting;
    const result = await reconciling;

    expect(result.body).toEqual({
      walletId: wallet.id,
      storedBalance: money("70.00"),
      calculatedBalance: money("70.00"),
      difference: money("0.00"),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("escrita que dá rollback: a reconciliação não vê nada dela", async () => {
    const error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const wallet = await openWallet(api.http, "100.00");
    const hold = holder.holdNext();
    const betting = submitWithDefaultKey(api.http, wagerPayload(wallet, { money: money("30.00") }));
    await hold.reached;
    const reconciling = reconcile(wallet.id);
    await waitUntilSomeoneWaitsOnLock(api.db.client);

    hold.release("rollback");
    await betting;
    const result = await reconciling;
    error.mockRestore();

    expect(result.body).toMatchObject({
      storedBalance: money("100.00"),
      consistent: true,
      checkedEntries: 1,
    });
  });
});

describe("reconciliação sob escrita concorrente em 3 instâncias", () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await startCluster(3);
  });

  afterAll(async () => {
    await cluster.close();
  });

  afterEach(async () => {
    await expectInvariants(cluster.db.client);
  });

  test("40 BETs e 40 reconciliações ao mesmo tempo: nenhum erro, nenhum deadlock e toda leitura é consistente", async () => {
    const wallet = await openWallet(cluster.http[0] as Cluster["http"][number], "10000.00");
    const bets = Array.from({ length: 40 }, (_, index) =>
      submitWithDefaultKey(
        cluster.http[index % 3] as Cluster["http"][number],
        wagerPayload(wallet, { money: money("1.00") }),
      ),
    );
    const reconciliations = Array.from({ length: 40 }, (_, index) =>
      (cluster.http[(index + 1) % 3] as Cluster["http"][number]).post(
        `/wallets/${wallet.id}/reconciliation`,
        {},
      ),
    );

    const results = await Promise.all([...bets, ...reconciliations]);

    expect(results.slice(0, 40).every((result) => result.status === 200)).toBe(true);
    const reads = results.slice(40);
    expect(reads.every((result) => result.status === 200)).toBe(true);
    for (const read of reads) {
      const body = read.body as Reconciliation;
      expect(body.consistent).toBe(true);
      expect(body.difference).toEqual(money("0.00"));
      const debited = body.checkedEntries - 1;
      expect(body.storedBalance).toEqual(money(`${10000 - debited}.00`));
    }
    expect((await walletSnapshot(cluster.db.client, wallet.id)).balance).toBe("9960.00");
  });
});
