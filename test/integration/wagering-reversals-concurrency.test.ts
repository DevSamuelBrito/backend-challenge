import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { HttpClient, HttpResult } from "../support/http";
import { expectInvariants } from "../support/invariants";
import {
  eventsOfTransaction,
  keyFor,
  ledgerOf,
  type OpenedWallet,
  openWallet,
  submit,
  transactionsOf,
  type WagerPayload,
  wagerPayload,
  walletSnapshot,
} from "../support/wagering-api";
import { type Cluster, startCluster } from "../support/wallet-api";

const INSTANCES = 3;
const money = (amount: string, currency = "BRL") => ({ amount, currency });

interface Outcome {
  transactionId: string;
  status: string;
  failureCode?: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
}

const outcomeOf = (response: HttpResult) => response.body as Outcome;
const statuses = (responses: HttpResult[]) => responses.map((response) => response.status);
const count = (values: unknown[], expected: unknown) =>
  values.filter((value) => value === expected).length;

describe(`concorrência de reversões: ${INSTANCES} instâncias da aplicação no mesmo banco (HTTP em paralelo)`, () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await startCluster(INSTANCES);
  });

  afterAll(async () => {
    await cluster.close();
  });

  afterEach(async () => {
    await expectInvariants(cluster.db.client);
  });

  const http = (index: number): HttpClient => cluster.http[index % INSTANCES] as HttpClient;
  const client = () => cluster.db.client;

  const placeBet = async (target: OpenedWallet, amount = "25.00") => {
    const payload = wagerPayload(target, { kind: "BET", money: money(amount) });
    const response = await submit(http(0), payload, keyFor(payload));
    expect(response.status).toBe(200);

    return payload;
  };

  const reversalOf = (
    target: OpenedWallet,
    kind: "REFUND" | "ROLLBACK",
    original: WagerPayload,
  ): WagerPayload =>
    wagerPayload(target, {
      kind,
      referenceExternalTransactionId: original.externalTransactionId,
      money: original.money,
      roundId: original.roundId,
    });

  const send = (index: number, payload: WagerPayload) =>
    submit(http(index), payload, keyFor(payload));

  const expectSingleReversal = async (target: OpenedWallet, responses: HttpResult[]) => {
    expect(statuses(responses).sort()).toEqual([200, 422]);

    const winner = outcomeOf(responses.find((response) => response.status === 200) as HttpResult);
    const loser = outcomeOf(responses.find((response) => response.status === 422) as HttpResult);

    expect(winner).toMatchObject({
      status: "PROCESSED",
      balance: money("100.00"),
      idempotentReplay: false,
    });
    expect(loser).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_ALREADY_REVERSED",
      balance: money("100.00"),
      idempotentReplay: false,
    });

    expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "100.00", version: 3 });

    const ledger = await ledgerOf(client(), target.id);
    expect(ledger.filter((entry) => entry.direction === "CREDIT")).toHaveLength(2);
    expect(ledger[2]?.transaction_id).toBe(winner.transactionId);

    expect(
      (await eventsOfTransaction(client(), winner.transactionId)).map((event) => event.event_type),
    ).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    expect(
      (await eventsOfTransaction(client(), loser.transactionId)).map((event) => event.event_type),
    ).toEqual(["WagerTransactionRejected"]);
  };

  describe("a mesma BET revertida duas vezes ao mesmo tempo, por instâncias diferentes", () => {
    test("20 rodadas de dois REFUNDs simultâneos: exatamente 1 PROCESSED, 1 REJECTED REFERENCE_ALREADY_REVERSED e um único crédito", async () => {
      for (let round = 0; round < 20; round++) {
        const target = await openWallet(http(round), "100.00");
        const original = await placeBet(target);

        const responses = await Promise.all([
          send(round, reversalOf(target, "REFUND", original)),
          send(round + 1, reversalOf(target, "REFUND", original)),
        ]);

        await expectSingleReversal(target, responses);
      }
    });

    test("20 rodadas de REFUND + ROLLBACK simultâneos: a D4 vale entre tipos diferentes", async () => {
      for (let round = 0; round < 20; round++) {
        const target = await openWallet(http(round), "100.00");
        const original = await placeBet(target);

        const responses = await Promise.all([
          send(round, reversalOf(target, "REFUND", original)),
          send(round + 1, reversalOf(target, "ROLLBACK", original)),
        ]);

        await expectSingleReversal(target, responses);
      }
    });

    test("5 reversões simultâneas da mesma BET: 1 vence e 4 são REFERENCE_ALREADY_REVERSED", async () => {
      const target = await openWallet(http(0), "100.00");
      const original = await placeBet(target);

      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          send(index, reversalOf(target, index % 2 === 0 ? "REFUND" : "ROLLBACK", original)),
        ),
      );

      expect(count(statuses(responses), 200)).toBe(1);
      expect(count(statuses(responses), 422)).toBe(4);
      expect(
        responses
          .filter((response) => response.status === 422)
          .map((response) => outcomeOf(response).failureCode),
      ).toEqual(Array(4).fill("REFERENCE_ALREADY_REVERSED"));
      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "100.00", version: 3 });
    });
  });

  describe("a MESMA reversão 50 vezes em paralelo, entre as instâncias", () => {
    test("REFUND: 1 execução e 49 replays, um único crédito, mesmo resultado para todos", async () => {
      const target = await openWallet(http(0), "100.00");
      const original = await placeBet(target);
      const refund = reversalOf(target, "REFUND", original);

      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => send(index, refund)),
      );

      expect(statuses(responses)).toEqual(Array(50).fill(200));

      const outcomes = responses.map(outcomeOf);
      expect(
        count(
          outcomes.map((outcome) => outcome.idempotentReplay),
          false,
        ),
      ).toBe(1);
      expect(
        count(
          outcomes.map((outcome) => outcome.idempotentReplay),
          true,
        ),
      ).toBe(49);
      expect(new Set(outcomes.map((outcome) => outcome.transactionId)).size).toBe(1);
      expect(new Set(outcomes.map((outcome) => outcome.balance.amount))).toEqual(
        new Set(["100.00"]),
      );

      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "100.00", version: 3 });
      const stored = await transactionsOf(client(), target.id);
      expect(stored.filter((row) => row.kind === "REFUND")).toHaveLength(1);
      expect(
        (await ledgerOf(client(), target.id)).filter((entry) => entry.direction === "CREDIT"),
      ).toHaveLength(2);
      expect(
        (await eventsOfTransaction(client(), outcomes[0]?.transactionId as string)).map(
          (event) => event.event_type,
        ),
      ).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    });

    test("ROLLBACK de WIN: 1 execução e 49 replays, um único débito", async () => {
      const target = await openWallet(http(0), "100.00");
      const prizePayload = wagerPayload(target, { kind: "WIN", money: money("50.00") });
      expect((await send(0, prizePayload)).status).toBe(200);
      const rollback = reversalOf(target, "ROLLBACK", prizePayload);

      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => send(index, rollback)),
      );

      expect(statuses(responses)).toEqual(Array(50).fill(200));
      expect(
        count(
          responses.map(outcomeOf).map((outcome) => outcome.idempotentReplay),
          false,
        ),
      ).toBe(1);
      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "100.00", version: 3 });
      expect(
        (await ledgerOf(client(), target.id)).filter((entry) => entry.direction === "DEBIT"),
      ).toHaveLength(1);
    });

    test("reversão REJECTED (já revertida) 50 vezes: 1 execução e 49 replays do mesmo 422", async () => {
      const target = await openWallet(http(0), "100.00");
      const original = await placeBet(target);
      expect((await send(0, reversalOf(target, "REFUND", original))).status).toBe(200);
      const second = reversalOf(target, "REFUND", original);

      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => send(index, second)),
      );

      expect(statuses(responses)).toEqual(Array(50).fill(422));
      const outcomes = responses.map(outcomeOf);
      expect(
        count(
          outcomes.map((outcome) => outcome.idempotentReplay),
          false,
        ),
      ).toBe(1);
      expect(new Set(outcomes.map((outcome) => outcome.failureCode))).toEqual(
        new Set(["REFERENCE_ALREADY_REVERSED"]),
      );
      expect(
        (await eventsOfTransaction(client(), outcomes[0]?.transactionId as string)).map(
          (event) => event.event_type,
        ),
      ).toEqual(["WagerTransactionRejected"]);
    });

    test("referência ausente 50 vezes: 1 linha PENDING_REFERENCE, 49 replays 202 e UM só evento PendingReference", async () => {
      const target = await openWallet(http(0), "100.00");
      const pending = wagerPayload(target, {
        kind: "REFUND",
        referenceExternalTransactionId: "bet-que-nao-chegou",
        money: money("25.00"),
      });

      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => send(index, pending)),
      );

      expect(statuses(responses)).toEqual(Array(50).fill(202));
      const outcomes = responses.map(outcomeOf);
      expect(
        count(
          outcomes.map((outcome) => outcome.idempotentReplay),
          false,
        ),
      ).toBe(1);
      expect(new Set(outcomes.map((outcome) => outcome.transactionId)).size).toBe(1);

      expect(await transactionsOf(client(), target.id)).toHaveLength(1);
      expect(
        (await eventsOfTransaction(client(), outcomes[0]?.transactionId as string)).map(
          (event) => event.event_type,
        ),
      ).toEqual(["WagerTransactionPendingReference"]);
      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "100.00", version: 1 });
    });
  });

  describe("reversão contra gasto: o saldo nunca fica negativo", () => {
    test("10 rodadas de ROLLBACK de WIN × BET que gasta o prêmio: exatamente um dos dois é aceito", async () => {
      for (let round = 0; round < 10; round++) {
        const target = await openWallet(http(round), "100.00");
        const prize = wagerPayload(target, { kind: "WIN", money: money("50.00") });
        expect((await send(round, prize)).status).toBe(200);

        const rollback = reversalOf(target, "ROLLBACK", prize);
        const spend = wagerPayload(target, { kind: "BET", money: money("120.00") });

        const [rollbackResponse, spendResponse] = await Promise.all([
          send(round, rollback),
          send(round + 1, spend),
        ]);

        const finalBalance = (await walletSnapshot(client(), target.id)).balance;

        expect(count([rollbackResponse.status, spendResponse.status], 200)).toBe(1);
        expect(count([rollbackResponse.status, spendResponse.status], 422)).toBe(1);

        if (rollbackResponse.status === 200) {
          expect(finalBalance).toBe("100.00");
          expect(outcomeOf(spendResponse).failureCode).toBe("INSUFFICIENT_FUNDS");
        } else {
          expect(finalBalance).toBe("30.00");
          expect(outcomeOf(rollbackResponse).failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
        }
      }
    });
  });

  describe("referência chegando fora de ordem, ao mesmo tempo que a reversão", () => {
    test("10 rodadas de BET × REFUND dela: ou o REFUND passa, ou fica PENDING_REFERENCE; o saldo bate com o desfecho", async () => {
      for (let round = 0; round < 10; round++) {
        const target = await openWallet(http(round), "100.00");
        const original = wagerPayload(target, { kind: "BET", money: money("25.00") });
        const refund = reversalOf(target, "REFUND", original);

        const [betResponse, refundResponse] = await Promise.all([
          send(round, original),
          send(round + 1, refund),
        ]);

        expect(betResponse.status).toBe(200);
        expect([200, 202]).toContain(refundResponse.status);

        const finalBalance = (await walletSnapshot(client(), target.id)).balance;
        const refundEvents = (
          await eventsOfTransaction(client(), outcomeOf(refundResponse).transactionId)
        ).map((event) => event.event_type);

        if (refundResponse.status === 200) {
          expect(finalBalance).toBe("100.00");
          expect(refundEvents).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
        } else {
          expect(finalBalance).toBe("75.00");
          expect(outcomeOf(refundResponse).status).toBe("PENDING_REFERENCE");
          expect(refundEvents).toEqual(["WagerTransactionPendingReference"]);
        }
      }
    });
  });

  describe("wallets diferentes não se bloqueiam", () => {
    test("12 wallets em paralelo, cada uma com BET e dois REFUNDs simultâneos: 1 vencedor por wallet", async () => {
      const wallets = await Promise.all(
        Array.from({ length: 12 }, (_, index) => openWallet(http(index), "100.00")),
      );
      const bets = await Promise.all(wallets.map((target) => placeBet(target)));

      const responses = await Promise.all(
        wallets.flatMap((target, index) => {
          const original = bets[index] as WagerPayload;

          return [
            send(index, reversalOf(target, "REFUND", original)),
            send(index + 1, reversalOf(target, "ROLLBACK", original)),
          ];
        }),
      );

      expect(count(statuses(responses), 200)).toBe(12);
      expect(count(statuses(responses), 422)).toBe(12);

      for (const target of wallets) {
        expect(await walletSnapshot(client(), target.id)).toEqual({
          balance: "100.00",
          version: 3,
        });
      }
    });
  });
});
