import { afterAll, afterEach, beforeAll, beforeEach, expect } from "bun:test";
import { CLOCK } from "../../src/shared/application/clock.port";
import { ControlledClock } from "./doubles";
import { expectInvariants } from "./invariants";
import { type PendingRow, rowOf, workerOf } from "./pending-worker";
import { insertRow, transactionRow } from "./schema-fixtures";
import {
  eventsOfTransaction,
  ledgerOf,
  type OpenedWallet,
  openWallet,
  submitWithDefaultKey,
  type WagerPayload,
  wagerPayload,
  walletSnapshot,
} from "./wagering-api";
import { startWalletApi, type WalletApi, type WalletApiOptions } from "./wallet-api";

export const T0 = new Date("2031-05-05T10:00:00.000Z");
export const money = (amount: string, currency = "BRL") => ({ amount, currency });

export interface Placed {
  payload: WagerPayload;
  status: number;
  body: {
    transactionId: string;
    status: string;
    failureCode?: string;
    balance: { amount: string; currency: string };
    idempotentReplay: boolean;
  };
}

export function useScenario(
  env: Record<string, string> = {},
  options: Omit<WalletApiOptions, "env" | "providers"> = {},
) {
  let api: WalletApi;
  const clock = new ControlledClock(T0);

  beforeAll(async () => {
    api = await startWalletApi({ ...options, env, providers: [{ token: CLOCK, value: clock }] });
  });

  afterAll(async () => {
    await api.close();
  });

  beforeEach(async () => {
    await api.db.client.query(
      `update wager_transactions
          set status = 'FAILED', processed_at = now(), next_attempt_at = null
        where status = 'PENDING_REFERENCE'`,
    );
    clock.set(T0);
  });

  afterEach(async () => {
    await expectInvariants(api.db.client);
  });

  const scenario = {
    clock,
    get api() {
      return api;
    },
    get client() {
      return api.db.client;
    },

    wallet: (balance = "100.00", currency = "BRL") => openWallet(api.http, balance, currency),

    async place(target: OpenedWallet, overrides: Partial<WagerPayload> = {}): Promise<Placed> {
      const payload = wagerPayload(target, overrides);
      const result = await submitWithDefaultKey(api.http, payload);

      return { payload, status: result.status, body: result.body as Placed["body"] };
    },

    async send(payload: WagerPayload): Promise<Placed> {
      const result = await submitWithDefaultKey(api.http, payload);

      return { payload, status: result.status, body: result.body as Placed["body"] };
    },

    async processed(target: OpenedWallet, overrides: Partial<WagerPayload> = {}) {
      const placed = await scenario.place(target, overrides);
      expect(placed.status).toBe(200);

      return placed;
    },

    async pending(target: OpenedWallet, overrides: Partial<WagerPayload>) {
      const placed = await scenario.place(target, overrides);
      expect(placed.status).toBe(202);
      expect(placed.body.status).toBe("PENDING_REFERENCE");

      return placed;
    },

    pendingReversal(
      target: OpenedWallet,
      kind: "REFUND" | "ROLLBACK",
      referenceExternalId: string,
      amount: string,
      overrides: Partial<WagerPayload> = {},
    ) {
      return scenario.pending(target, {
        kind,
        referenceExternalTransactionId: referenceExternalId,
        money: money(amount),
        ...overrides,
      });
    },

    futurePayload(target: OpenedWallet, overrides: Partial<WagerPayload>): WagerPayload {
      return wagerPayload(target, overrides);
    },

    tickAt(instant: Date) {
      clock.set(instant);

      return workerOf(api).tick(instant);
    },

    tickAfter(ms: number) {
      return workerOf(api).tick(clock.advance(ms));
    },

    row: (transactionId: string): Promise<PendingRow> => rowOf(api.db.client, transactionId),

    async eventTypes(transactionId: string) {
      return (await eventsOfTransaction(api.db.client, transactionId)).map(
        (event) => event.event_type,
      );
    },

    async movements(target: OpenedWallet) {
      return (await ledgerOf(api.db.client, target.id)).slice(1).map((entry) => ({
        direction: entry.direction,
        amount: entry.amount,
        balanceAfter: entry.balance_after,
      }));
    },

    async balanceOf(target: OpenedWallet) {
      return (await walletSnapshot(api.db.client, target.id)).balance;
    },

    snapshot: (target: OpenedWallet) => walletSnapshot(api.db.client, target.id),

    async seedTransaction(
      target: OpenedWallet,
      status: string,
      overrides: Record<string, unknown> = {},
    ): Promise<{ externalId: string; id: string }> {
      const row = transactionRow(target.id, {
        player_id: target.playerId,
        status,
        external_transaction_id: `seed-${crypto.randomUUID()}`,
        ...(status === "REJECTED" && { failure_code: "INSUFFICIENT_FUNDS" }),
        ...overrides,
      });
      await insertRow(api.db.client, "wager_transactions", row);

      return { externalId: row.external_transaction_id as string, id: row.id as string };
    },
  };

  return scenario;
}
