import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { PendingReferenceTickReport } from "../../src/modules/wagering/application/pending-reference-worker";
import { CLOCK } from "../../src/shared/application/clock.port";
import { ControlledClock } from "../support/doubles";
import type { HttpClient } from "../support/http";
import { expectInvariants } from "../support/invariants";
import { rowOf, workerOf } from "../support/pending-worker";
import {
  eventsOfTransaction,
  keyFor,
  ledgerOf,
  type OpenedWallet,
  openWallet,
  submit,
  type WagerPayload,
  wagerPayload,
  walletSnapshot,
} from "../support/wagering-api";
import { type AppInstance, type Cluster, startCluster } from "../support/wallet-api";

const INSTANCES = 3;
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const T0 = new Date("2032-01-01T00:00:00.000Z");
const money = (amount: string) => ({ amount, currency: "BRL" });

const sumOf = (reports: PendingReferenceTickReport[], field: keyof PendingReferenceTickReport) =>
  reports.reduce((total, report) => total + report[field], 0);

describe(`worker de PENDING_REFERENCE com ${INSTANCES} instâncias no mesmo banco`, () => {
  const clock = new ControlledClock(T0);
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await startCluster(INSTANCES, {
      providers: [{ token: CLOCK, value: clock }],
      env: { APP_ROLES: "api", PENDING_WORKER_BATCH_SIZE: "100" },
    });
  });

  afterAll(async () => {
    await cluster.close();
  });

  beforeEach(async () => {
    await cluster.db.client.query(
      `update wager_transactions
          set status = 'FAILED', processed_at = now(), next_attempt_at = null
        where status = 'PENDING_REFERENCE'`,
    );
  });

  afterEach(async () => {
    await expectInvariants(cluster.db.client);
  });

  const http = (index: number): HttpClient => cluster.http[index % INSTANCES] as HttpClient;
  const client = () => cluster.db.client;
  const send = (index: number, payload: WagerPayload) =>
    submit(http(index), payload, keyFor(payload));
  const tickEverywhere = (now: Date) =>
    Promise.all(cluster.instances.map((instance) => workerOf(instance).tick(now)));
  const workerAt = (index: number) => workerOf(cluster.instances[index % INSTANCES] as AppInstance);
  const startOfRound = () => clock.advance(HOUR);

  const eventTypes = async (transactionId: string) =>
    (await eventsOfTransaction(client(), transactionId)).map((event) => event.event_type);

  test("as instâncias têm workers distintos, mas o mesmo banco", () => {
    const workers = cluster.instances.map((instance) => workerOf(instance));

    expect(new Set(workers).size).toBe(INSTANCES);
  });

  describe("muitas pendências, em várias wallets e várias na mesma wallet", () => {
    test("4 rodadas: 8 wallets × 5 REFUNDs pendentes cada, 3 workers em paralelo => cada pendência resolvida exatamente uma vez", async () => {
      for (let round = 0; round < 4; round++) {
        startOfRound();
        const wallets = await Promise.all(
          Array.from({ length: 8 }, (_, index) => openWallet(http(index), "100.00")),
        );
        const plans = wallets.map((target) => ({
          target,
          bets: Array.from({ length: 5 }, () =>
            wagerPayload(target, { kind: "BET", money: money("10.00") }),
          ),
        }));

        const pendings = await Promise.all(
          plans.flatMap(({ target, bets }, walletIndex) =>
            bets.map((bet, betIndex) =>
              send(
                walletIndex + betIndex,
                wagerPayload(target, {
                  kind: "REFUND",
                  referenceExternalTransactionId: bet.externalTransactionId,
                  money: money("10.00"),
                }),
              ),
            ),
          ),
        );
        expect(pendings.map((response) => response.status)).toEqual(Array(40).fill(202));

        const placed = await Promise.all(
          plans.flatMap(({ bets }, walletIndex) =>
            bets.map((bet, betIndex) => send(walletIndex + betIndex, bet)),
          ),
        );
        expect(placed.map((response) => response.status)).toEqual(Array(40).fill(200));

        const reports = await tickEverywhere(clock.advance(SECOND));

        expect(sumOf(reports, "failed")).toBe(0);
        expect(sumOf(reports, "processed")).toBe(40);
        expect(sumOf(reports, "rejected") + sumOf(reports, "exhausted")).toBe(0);
        expect(sumOf(reports, "rescheduled")).toBe(0);

        for (const { target } of plans) {
          expect(await walletSnapshot(client(), target.id)).toEqual({
            balance: "100.00",
            version: 11,
          });
          const entries = await ledgerOf(client(), target.id);
          expect(entries).toHaveLength(11);
          expect(new Set(entries.map((entry) => entry.transaction_id)).size).toBe(11);
        }

        for (const response of pendings) {
          const { transactionId } = response.body as { transactionId: string };
          expect(await eventTypes(transactionId)).toEqual([
            "WagerTransactionPendingReference",
            "WagerTransactionProcessed",
            "WalletBalanceChanged",
          ]);
          expect((await rowOf(client(), transactionId)).status).toBe("PROCESSED");
        }

        expect(sumOf(reports, "candidates")).toBeGreaterThanOrEqual(40);
        expect(sumOf(reports, "skipped")).toBe(sumOf(reports, "candidates") - 40);
      }
    });

    test("uma wallet quente: 30 pendências resolvidas por 3 workers ao mesmo tempo, sem deadlock e com a cadeia do ledger contínua", async () => {
      startOfRound();
      const target = await openWallet(http(0), "100.00");
      const bets = Array.from({ length: 30 }, () =>
        wagerPayload(target, { kind: "BET", money: money("2.00") }),
      );
      await Promise.all(
        bets.map((bet, index) =>
          send(
            index,
            wagerPayload(target, {
              kind: "ROLLBACK",
              referenceExternalTransactionId: bet.externalTransactionId,
              money: money("2.00"),
            }),
          ),
        ),
      );
      await Promise.all(bets.map((bet, index) => send(index, bet)));

      const reports = await tickEverywhere(clock.advance(SECOND));

      expect(sumOf(reports, "failed")).toBe(0);
      expect(sumOf(reports, "processed")).toBe(30);
      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "100.00", version: 61 });
      expect(await ledgerOf(client(), target.id)).toHaveLength(61);
    });

    test("pendências cuja referência nunca chega: cada tick devido conta UMA tentativa, mesmo com 3 workers disputando", async () => {
      startOfRound();
      const wallets = await Promise.all(
        Array.from({ length: 6 }, (_, index) => openWallet(http(index), "100.00")),
      );
      const pendings = await Promise.all(
        wallets.map((target, index) =>
          send(
            index,
            wagerPayload(target, {
              kind: "REFUND",
              referenceExternalTransactionId: "nunca-chega",
              money: money("10.00"),
            }),
          ),
        ),
      );
      const ids = pendings.map(
        (response) => (response.body as { transactionId: string }).transactionId,
      );

      for (const expectedAttempts of [1, 2, 3]) {
        const next = (await rowOf(client(), ids[0] as string)).next_attempt_at as Date;
        const reports = await tickEverywhere(next);

        expect(sumOf(reports, "failed")).toBe(0);
        expect(sumOf(reports, "rescheduled")).toBe(6);
        for (const id of ids) {
          expect((await rowOf(client(), id)).reference_attempts).toBe(expectedAttempts);
          expect(await eventTypes(id)).toEqual(["WagerTransactionPendingReference"]);
        }
      }
    });

    test("esgotamento concorrente: a pendência é rejeitada exatamente uma vez, com um só evento Rejected", async () => {
      startOfRound();
      const target = await openWallet(http(0), "100.00");
      const pending = await send(
        0,
        wagerPayload(target, {
          kind: "REFUND",
          referenceExternalTransactionId: "nunca-chega",
          money: money("10.00"),
        }),
      );
      const { transactionId } = pending.body as { transactionId: string };
      await client().query("update wager_transactions set reference_attempts = 9 where id = $1", [
        transactionId,
      ]);

      const reports = await tickEverywhere(clock.advance(SECOND));

      expect(sumOf(reports, "exhausted")).toBe(1);
      expect(sumOf(reports, "failed")).toBe(0);
      expect(await rowOf(client(), transactionId)).toMatchObject({
        status: "REJECTED",
        failure_code: "REFERENCE_NOT_FOUND",
        reference_attempts: 10,
      });
      expect(await eventTypes(transactionId)).toEqual([
        "WagerTransactionPendingReference",
        "WagerTransactionRejected",
      ]);
    });
  });

  describe("o worker disputando com o fluxo normal pela mesma referência", () => {
    for (const reversal of ["REFUND", "ROLLBACK"] as const) {
      test(`15 rodadas: worker (REFUND pendente) × ${reversal} novo da mesma BET => um PROCESSED e um REFERENCE_ALREADY_REVERSED`, async () => {
        for (let round = 0; round < 15; round++) {
          startOfRound();
          const target = await openWallet(http(round), "100.00");
          const original = wagerPayload(target, { kind: "BET", money: money("25.00") });
          const pending = await send(
            round,
            wagerPayload(target, {
              kind: "REFUND",
              referenceExternalTransactionId: original.externalTransactionId,
              money: money("25.00"),
            }),
          );
          expect(pending.status).toBe(202);
          expect((await send(round, original)).status).toBe(200);
          const competitor = wagerPayload(target, {
            kind: reversal,
            referenceExternalTransactionId: original.externalTransactionId,
            money: money("25.00"),
          });
          const now = clock.advance(SECOND);

          const [report, competing] = await Promise.all([
            workerAt(round).tick(now),
            send(round + 1, competitor),
          ]);

          const pendingId = (pending.body as { transactionId: string }).transactionId;
          const pendingRow = await rowOf(client(), pendingId);
          const competingBody = competing.body as { status: string; failureCode?: string };
          const outcomes = [pendingRow.status, competingBody.status].sort();

          expect(report.failed).toBe(0);
          expect(outcomes).toEqual(["PROCESSED", "REJECTED"]);
          const rejectedCode =
            pendingRow.status === "REJECTED" ? pendingRow.failure_code : competingBody.failureCode;
          expect(rejectedCode).toBe("REFERENCE_ALREADY_REVERSED");
          expect(await walletSnapshot(client(), target.id)).toEqual({
            balance: "100.00",
            version: 3,
          });
          expect(
            (await ledgerOf(client(), target.id)).filter((entry) => entry.direction === "CREDIT"),
          ).toHaveLength(2);
        }
      });
    }

    test("a referência chegando ao mesmo tempo que o tick: ou o worker já resolve, ou resolve no tick seguinte, nunca duas vezes", async () => {
      for (let round = 0; round < 15; round++) {
        startOfRound();
        const target = await openWallet(http(round), "100.00");
        const original = wagerPayload(target, { kind: "BET", money: money("25.00") });
        const pending = await send(
          round,
          wagerPayload(target, {
            kind: "REFUND",
            referenceExternalTransactionId: original.externalTransactionId,
            money: money("25.00"),
          }),
        );
        const { transactionId } = pending.body as { transactionId: string };

        const [bet] = await Promise.all([
          send(round + 1, original),
          workerAt(round).tick(clock.advance(SECOND)),
        ]);
        expect(bet.status).toBe(200);
        await tickEverywhere(clock.advance(HOUR / 2));

        expect((await rowOf(client(), transactionId)).status).toBe("PROCESSED");
        expect(await walletSnapshot(client(), target.id)).toEqual({
          balance: "100.00",
          version: 3,
        });
        expect(await eventTypes(transactionId)).toEqual([
          "WagerTransactionPendingReference",
          "WagerTransactionProcessed",
          "WalletBalanceChanged",
        ]);
      }
    });
  });

  describe("cadeias sob concorrência", () => {
    test("ROLLBACK pendente de WIN pendente: 3 workers em ticks repetidos resolvem os dois, cada um uma vez, na ordem certa", async () => {
      for (let round = 0; round < 8; round++) {
        startOfRound();
        const target: OpenedWallet = await openWallet(http(round), "100.00");
        const original = wagerPayload(target, { kind: "BET", money: money("25.00") });
        const prize = wagerPayload(target, {
          kind: "WIN",
          referenceExternalTransactionId: original.externalTransactionId,
          money: money("60.00"),
        });
        const rollback = await send(
          round,
          wagerPayload(target, {
            kind: "ROLLBACK",
            referenceExternalTransactionId: prize.externalTransactionId,
            money: money("60.00"),
          }),
        );
        const pendingPrize = await send(round, prize);
        expect([rollback.status, pendingPrize.status]).toEqual([202, 202]);
        expect((await send(round, original)).status).toBe(200);

        for (let tick = 0; tick < 4; tick++) {
          const reports = await tickEverywhere(clock.advance(5 * SECOND));
          expect(sumOf(reports, "failed")).toBe(0);
        }

        const rollbackId = (rollback.body as { transactionId: string }).transactionId;
        const prizeId = (pendingPrize.body as { transactionId: string }).transactionId;
        expect((await rowOf(client(), prizeId)).status).toBe("PROCESSED");
        expect((await rowOf(client(), rollbackId)).status).toBe("PROCESSED");
        expect(
          (await ledgerOf(client(), target.id)).map((entry) => [entry.direction, entry.amount]),
        ).toEqual([
          ["CREDIT", "100.00"],
          ["DEBIT", "25.00"],
          ["CREDIT", "60.00"],
          ["DEBIT", "60.00"],
        ]);
        expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "75.00", version: 4 });
      }
    });
  });
});
