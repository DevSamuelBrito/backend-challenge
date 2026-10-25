import { describe, expect } from "bun:test";
import { waitUntilSomeoneWaitsOnLock } from "../support/async";
import {
  keyOf,
  ledgerEntryCount,
  newBet,
  pick,
  scenarioTest,
  statusCounts,
  submitResilient,
  sumMetric,
  transactionCount,
} from "../support/process-scenario";
import { transactionsOf, walletSnapshot } from "../support/wagering-api";

const PROCESS_COUNT = 3;

describe("3 processos de API sobre o mesmo banco (cenários 1, 2, 3 e 4 por HTTP)", () => {
  scenarioTest(
    "cenário 1: a mesma BET 50 vezes em paralelo vira 1 execução, 49 replays e 1 débito",
    async (scenario) => {
      const processes = await scenario.startMany(PROCESS_COUNT, { roles: ["api"] });
      const wallet = await scenario.wallet(pick(processes, 0), "100.00");
      const bet = newBet(wallet, "10.00");
      const key = keyOf(bet);

      const results = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          submitResilient(scenario, bet, key, {
            targets: () => [pick(processes, index)],
          }),
        ),
      );

      expect(results.map((result) => result.status)).toEqual(Array(50).fill(200));
      expect(
        new Set(results.map((result) => (result.body as { transactionId: string }).transactionId))
          .size,
      ).toBe(1);

      expect(await statusCounts(scenario.client, wallet.id)).toEqual({ "BET:PROCESSED": 1 });
      expect(await ledgerEntryCount(scenario.client, wallet.id)).toBe(2);
      expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("90.00");

      expect(
        await sumMetric(processes, "wager_transactions_total", {
          kind: "BET",
          status: "PROCESSED",
        }),
      ).toBe(1);
      expect(
        await sumMetric(processes, "wager_duplicates_total", {
          type: "idempotent_replay",
          source: "http",
        }),
      ).toBe(49);

      for (const child of processes) {
        expect(
          await sumMetric([child], "wager_processing_duration_seconds_count", { source: "http" }),
        ).toBeGreaterThan(0);
      }
    },
  );

  scenarioTest(
    "cenário 2: saldo 100.00 e duas BETs de 80.00 simultâneas, em 8 wallets, entre processos diferentes",
    async (scenario) => {
      const processes = await scenario.startMany(PROCESS_COUNT, { roles: ["api"] });
      const wallets = await Promise.all(
        Array.from({ length: 8 }, () => scenario.wallet(pick(processes, 0), "100.00")),
      );

      const outcomes = await Promise.all(
        wallets.map(async (wallet, index) => {
          const first = newBet(wallet, "80.00");
          const second = newBet(wallet, "80.00");
          const results = await Promise.all([
            submitResilient(scenario, first, keyOf(first), {
              targets: () => [pick(processes, index)],
            }),
            submitResilient(scenario, second, keyOf(second), {
              targets: () => [pick(processes, index + 1)],
            }),
          ]);

          return { wallet, statuses: results.map((result) => result.status).sort() };
        }),
      );

      for (const { wallet, statuses } of outcomes) {
        expect(statuses).toEqual([200, 422]);
        expect(await statusCounts(scenario.client, wallet.id)).toEqual({
          "BET:PROCESSED": 1,
          "BET:REJECTED": 1,
        });
        expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("20.00");
        expect(await ledgerEntryCount(scenario.client, wallet.id)).toBe(2);

        const rejected = (await transactionsOf(scenario.client, wallet.id)).filter(
          (row) => row.status === "REJECTED",
        );
        expect(rejected.map((row) => row.failure_code)).toEqual(["INSUFFICIENT_FUNDS"]);
      }
    },
  );

  scenarioTest(
    "cenário 3: N wallets x M apostas em paralelo pelos 3 processos, com invariantes por wallet",
    async (scenario) => {
      const processes = await scenario.startMany(PROCESS_COUNT, { roles: ["api"] });
      const wallets = await Promise.all(
        Array.from({ length: 6 }, () => scenario.wallet(pick(processes, 0), "100.00")),
      );
      const betsPerWallet = 8;

      const results = await Promise.all(
        wallets.flatMap((wallet, walletIndex) =>
          Array.from({ length: betsPerWallet }, (_, betIndex) => {
            const bet = newBet(wallet, "10.00");

            return submitResilient(scenario, bet, keyOf(bet), {
              targets: () => [pick(processes, walletIndex + betIndex)],
            });
          }),
        ),
      );

      expect(results.every((result) => result.status === 200)).toBe(true);

      for (const wallet of wallets) {
        expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("20.00");
        expect(await statusCounts(scenario.client, wallet.id)).toEqual({
          "BET:PROCESSED": betsPerWallet,
        });
        expect(await ledgerEntryCount(scenario.client, wallet.id)).toBe(betsPerWallet + 1);
      }
    },
  );

  scenarioTest(
    "cenário 3: uma wallet travada não bloqueia as outras, em nenhum dos 3 processos",
    async (scenario) => {
      const processes = await scenario.startMany(PROCESS_COUNT, { roles: ["api"] });
      const locked = await scenario.wallet(pick(processes, 0), "100.00");
      const others = await Promise.all(
        Array.from({ length: 6 }, () => scenario.wallet(pick(processes, 1), "100.00")),
      );

      const holder = await scenario.db.connect();
      await holder.query("begin");
      await holder.query("select id from wallets where id = $1 for update", [locked.id]);

      const blockedBet = newBet(locked, "10.00");
      let blockedSettled = false;
      const blocked = submitResilient(scenario, blockedBet, keyOf(blockedBet), {
        targets: () => [pick(processes, 0)],
      }).finally(() => {
        blockedSettled = true;
      });

      try {
        await waitUntilSomeoneWaitsOnLock(scenario.client);

        const results = await Promise.all(
          others.flatMap((wallet, walletIndex) =>
            Array.from({ length: 3 }, (_, betIndex) => {
              const bet = newBet(wallet, "10.00");

              return submitResilient(scenario, bet, keyOf(bet), {
                targets: () => [pick(processes, walletIndex + betIndex)],
              });
            }),
          ),
        );

        expect(results.every((result) => result.status === 200)).toBe(true);
        expect(blockedSettled).toBe(false);
        expect(await transactionCount(scenario.client, locked.id)).toBe(0);
      } finally {
        await holder.query("rollback");
      }

      expect((await blocked).status).toBe(200);
      expect((await walletSnapshot(scenario.client, locked.id)).balance).toBe("90.00");

      for (const wallet of others) {
        expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("70.00");
      }
    },
    { env: { DB_LOCK_TIMEOUT_MS: "30000" } },
  );
});
