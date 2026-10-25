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
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { type FaultPlan, faultyUnitOfWork, INJECTED_FAILURE } from "../support/fault-injection";
import { expectInvariants } from "../support/invariants";
import { tableCounts } from "../support/table-counts";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

const request = (playerId: string, amount: string) => ({
  playerId,
  initialBalance: { amount, currency: "BRL" },
});

describe("POST /wallets com falha injetada no meio da transação", () => {
  const plan: FaultPlan = {};
  let api: WalletApi;
  let logged: unknown[];

  beforeAll(async () => {
    api = await startWalletApi({ wrapUnitOfWork: (real) => faultyUnitOfWork(real, plan) });
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(() => {
    plan.failAt = undefined;
    logged = [];
    spyOn(Logger.prototype, "error").mockImplementation((message: unknown) => {
      logged.push(message);
    });
  });

  afterEach(async () => {
    (Logger.prototype.error as unknown as { mockRestore(): void }).mockRestore();
    await expectInvariants(api.db.client);
  });

  const withOpening: [string, string][] = [
    ["wallets.add:1", "depois de gravar a wallet"],
    ["transactions.add:1", "depois de gravar a transação OPENING"],
    ["ledger.append:1", "depois de gravar o lançamento no ledger"],
    ["outbox.add:1", "depois do primeiro evento da outbox"],
    ["outbox.add:2", "depois do segundo evento da outbox, a um passo do commit"],
  ];

  for (const [point, description] of withOpening) {
    test(`saldo > 0, falha ${description}: 500 genérico, nada persiste e o retry funciona`, async () => {
      const playerId = `player-${randomUUID()}`;
      const before = await tableCounts(api.db.client);
      plan.failAt = point;

      const failed = await api.http.post("/wallets", request(playerId, "100.00"));

      expect(plan.failAt).toBeUndefined();
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ code: "INTERNAL_ERROR", message: "Erro interno do servidor" });
      expect(JSON.stringify(failed.body)).not.toContain(INJECTED_FAILURE);
      expect(logged[0]).toMatchObject({ event: "http.unhandled_error", errorName: "Error" });
      expect(JSON.stringify(logged[0])).not.toContain(INJECTED_FAILURE);
      expect(await tableCounts(api.db.client)).toEqual(before);

      const retried = await api.http.post("/wallets", request(playerId, "100.00"));

      expect(retried.status).toBe(201);
      const after = await tableCounts(api.db.client);
      expect(after.wallets).toBe(before.wallets + 1);
      expect(after.wager_transactions).toBe(before.wager_transactions + 1);
      expect(after.wallet_ledger_entries).toBe(before.wallet_ledger_entries + 1);
      expect(after.outbox_messages).toBe(before.outbox_messages + 2);
    });
  }

  test("saldo zero, falha depois de gravar a wallet: 500 e nada persiste", async () => {
    const playerId = `player-${randomUUID()}`;
    const before = await tableCounts(api.db.client);
    plan.failAt = "wallets.add:1";

    const failed = await api.http.post("/wallets", request(playerId, "0.00"));

    expect(plan.failAt).toBeUndefined();
    expect(failed.status).toBe(500);
    expect(await tableCounts(api.db.client)).toEqual(before);

    const retried = await api.http.post("/wallets", request(playerId, "0.00"));
    expect(retried.status).toBe(201);
  });

  test("uma falha numa requisição não afeta outra que corre ao mesmo tempo", async () => {
    const failing = `player-${randomUUID()}`;
    const healthy = `player-${randomUUID()}`;
    plan.failAt = "ledger.append:1";

    const [first, second] = await Promise.all([
      api.http.post("/wallets", request(failing, "10.00")),
      api.http.post("/wallets", request(healthy, "20.00")),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 500]);

    const stored = await api.db.client.query(
      "select player_id from wallets where player_id in ($1, $2)",
      [failing, healthy],
    );
    expect(stored.rows).toHaveLength(1);
  });
});
