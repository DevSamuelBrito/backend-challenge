import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Scenario } from "../support/process-scenario";
import {
  ledgerEntryCount,
  newBet,
  scenarioTest,
  sendWagerMessage,
  statusCounts,
  sumMetric,
  transactionCount,
} from "../support/process-scenario";
import { transactionsOf, walletSnapshot } from "../support/wagering-api";

const CONSUMER_COUNT = 3;

async function startConsumers(scenario: Scenario) {
  return scenario.startMany(CONSUMER_COUNT, { roles: ["consumer"] });
}

const drained = (scenario: Scenario) => async () => (await scenario.queues.inputDepth()) === 0;

describe("3 processos consumidores sobre a mesma fila (cenários 1, 2, 3 e 4 por SQS)", () => {
  scenarioTest(
    "cenário 1: a mesma BET em 50 mensagens vira 1 execução, 49 replays e 1 débito",
    async (scenario) => {
      const api = await scenario.start({ roles: ["api"] });
      const wallet = await scenario.wallet(api, "100.00");
      const bet = newBet(wallet, "10.00");

      for (let copy = 0; copy < 50; copy++) {
        await sendWagerMessage(scenario.queues, bet);
      }

      const consumers = await startConsumers(scenario);
      await scenario.poll("a fila de entrada esvaziar", drained(scenario));

      expect(await statusCounts(scenario.client, wallet.id)).toEqual({ "BET:PROCESSED": 1 });
      expect(await ledgerEntryCount(scenario.client, wallet.id)).toBe(2);
      expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("90.00");
      expect(await scenario.queues.dlqDepth()).toBe(0);

      expect(
        await sumMetric(consumers, "wager_transactions_total", {
          kind: "BET",
          status: "PROCESSED",
        }),
      ).toBe(1);
      expect(
        await sumMetric(consumers, "wager_duplicates_total", {
          type: "idempotent_replay",
          source: "sqs",
        }),
      ).toBe(49);
    },
  );

  scenarioTest(
    "cenário 1: a mesma mensagem (mesmo messageId) entregue 50 vezes é aplicada uma só vez",
    async (scenario) => {
      const api = await scenario.start({ roles: ["api"] });
      const wallet = await scenario.wallet(api, "100.00");
      const bet = newBet(wallet, "10.00");
      const messageId = `msg-${randomUUID()}`;

      for (let copy = 0; copy < 50; copy++) {
        await sendWagerMessage(scenario.queues, bet, { messageId });
      }

      const consumers = await startConsumers(scenario);
      await scenario.poll("a fila de entrada esvaziar", drained(scenario));

      expect(await statusCounts(scenario.client, wallet.id)).toEqual({ "BET:PROCESSED": 1 });
      expect(await ledgerEntryCount(scenario.client, wallet.id)).toBe(2);
      expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("90.00");
      expect(
        await sumMetric(consumers, "wager_transactions_total", {
          kind: "BET",
          status: "PROCESSED",
        }),
      ).toBe(1);

      const { rows } = await scenario.client.query(
        "select count(*)::int as total from inbox_messages where message_id = $1",
        [messageId],
      );
      expect(rows[0].total).toBe(1);
      expect(await scenario.queues.dlqDepth()).toBe(0);
    },
  );

  scenarioTest(
    "cenário 2: duas BETs de 80.00 sobre 100.00 em 8 wallets dão 1 PROCESSED, 1 REJECTED e saldo 20.00",
    async (scenario) => {
      const api = await scenario.start({ roles: ["api"] });
      const wallets = await Promise.all(
        Array.from({ length: 8 }, () => scenario.wallet(api, "100.00")),
      );

      for (const wallet of wallets) {
        await sendWagerMessage(scenario.queues, newBet(wallet, "80.00"));
        await sendWagerMessage(scenario.queues, newBet(wallet, "80.00"));
      }

      await startConsumers(scenario);
      await scenario.poll("a fila de entrada esvaziar", drained(scenario));

      for (const wallet of wallets) {
        expect(await statusCounts(scenario.client, wallet.id)).toEqual({
          "BET:PROCESSED": 1,
          "BET:REJECTED": 1,
        });
        expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("20.00");
        expect(await ledgerEntryCount(scenario.client, wallet.id)).toBe(2);
        expect(
          (await transactionsOf(scenario.client, wallet.id))
            .filter((row) => row.status === "REJECTED")
            .map((row) => row.failure_code),
        ).toEqual(["INSUFFICIENT_FUNDS"]);
      }
      expect(await scenario.queues.dlqDepth()).toBe(0);
    },
  );

  scenarioTest(
    "cenário 3: 6 wallets x 8 apostas pela fila, em grupos aleatórios, com invariantes por wallet",
    async (scenario) => {
      const api = await scenario.start({ roles: ["api"] });
      const wallets = await Promise.all(
        Array.from({ length: 6 }, () => scenario.wallet(api, "100.00")),
      );
      const betsPerWallet = 8;

      for (const wallet of wallets) {
        for (let index = 0; index < betsPerWallet; index++) {
          await sendWagerMessage(scenario.queues, newBet(wallet, "10.00"));
        }
      }

      await startConsumers(scenario);
      await scenario.poll("a fila de entrada esvaziar", drained(scenario));

      for (const wallet of wallets) {
        expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("20.00");
        expect(await transactionCount(scenario.client, wallet.id)).toBe(betsPerWallet);
        expect(await ledgerEntryCount(scenario.client, wallet.id)).toBe(betsPerWallet + 1);
      }
      expect(await scenario.queues.dlqDepth()).toBe(0);
    },
  );
});
