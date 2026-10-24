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
import { Logger } from "@nestjs/common";
import { type FaultPlan, faultyUnitOfWork, INJECTED_FAILURE } from "../support/fault-injection";
import { expectInvariants } from "../support/invariants";
import { tableCounts } from "../support/table-counts";
import {
  keyFor,
  type OpenedWallet,
  openWallet,
  submit,
  transactionsOf,
  type WagerPayload,
  wagerPayload,
  walletSnapshot,
} from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

const money = (amount: string) => ({ amount, currency: "BRL" });

describe("POST /wagering/transactions com falha injetada no meio da transação", () => {
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

  const scenarios: [string, Partial<WagerPayload>, string[]][] = [
    [
      "BET aceita",
      { money: money("30.00") },
      ["transactions.add:1", "ledger.append:1", "wallets.save:1", "outbox.add:1", "outbox.add:2"],
    ],
    [
      "WIN aceita",
      { kind: "WIN", money: money("30.00") },
      ["transactions.add:1", "ledger.append:1", "wallets.save:1", "outbox.add:1", "outbox.add:2"],
    ],
    ["LOSS", { kind: "LOSS", money: money("30.00") }, ["transactions.add:1", "outbox.add:1"]],
    ["BET rejeitada por saldo", { money: money("900.00") }, ["transactions.add:1", "outbox.add:1"]],
  ];

  for (const [name, overrides, points] of scenarios) {
    for (const point of points) {
      test(`${name}, falha depois de ${point}: 500 genérico, nada persiste e o retry da mesma chave funciona`, async () => {
        const wallet: OpenedWallet = await openWallet(api.http, "100.00");
        const payload = wagerPayload(wallet, overrides);
        const key = keyFor(payload);
        const before = await tableCounts(api.db.client);
        plan.failAt = point;

        const failed = await submit(api.http, payload, key);

        expect(plan.failAt).toBeUndefined();
        expect(failed.status).toBe(500);
        expect(failed.body).toEqual({
          code: "INTERNAL_ERROR",
          message: "Erro interno do servidor",
        });
        expect(JSON.stringify(failed.body)).not.toContain(INJECTED_FAILURE);
        expect(String(logged[0])).toContain(INJECTED_FAILURE);
        expect(await tableCounts(api.db.client)).toEqual(before);
        expect(await walletSnapshot(api.db.client, wallet.id)).toEqual({
          balance: "100.00",
          version: 1,
        });
        expect(await transactionsOf(api.db.client, wallet.id)).toEqual([]);

        const retried = await submit(api.http, payload, key);

        expect([200, 422]).toContain(retried.status);
        expect(retried.body).toMatchObject({ idempotentReplay: false });
        expect(await transactionsOf(api.db.client, wallet.id)).toHaveLength(1);
      });
    }
  }

  test("depois da falha e do retry bem-sucedido, um novo envio da mesma chave é replay, sem segundo débito", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const payload = wagerPayload(wallet, { money: money("30.00") });
    const key = keyFor(payload);
    plan.failAt = "ledger.append:1";

    await submit(api.http, payload, key);
    const retried = await submit(api.http, payload, key);
    const replay = await submit(api.http, payload, key);

    expect(retried.body).toMatchObject({ idempotentReplay: false, balance: money("70.00") });
    expect(replay.body).toMatchObject({ idempotentReplay: true, balance: money("70.00") });
    expect(await walletSnapshot(api.db.client, wallet.id)).toEqual({
      balance: "70.00",
      version: 2,
    });
  });
});
