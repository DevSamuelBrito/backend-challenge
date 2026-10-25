import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import {
  keyOf,
  ledgerEntryCount,
  newBet,
  scenarioTest,
  sendWagerMessage,
  statusCounts,
  submitResilient,
} from "../support/process-scenario";
import {
  eventsOfTransaction,
  ledgerOf,
  transactionsOf,
  walletSnapshot,
} from "../support/wagering-api";

async function idOf(client: Client, walletId: string, kind: string): Promise<string> {
  const row = (await transactionsOf(client, walletId)).find((candidate) => candidate.kind === kind);

  return (row as { id: string }).id;
}

async function eventTypesOf(client: Client, transactionId: string): Promise<string[]> {
  return (await eventsOfTransaction(client, transactionId)).map((event) => event.event_type);
}

describe("cenário 7: REFUND/ROLLBACK entregue antes da referência, com processos separados", () => {
  scenarioTest(
    "REFUND antes da BET: 202 PENDING_REFERENCE, depois a BET, e o worker (outro processo) resolve",
    async (scenario) => {
      const serving = await scenario.start({ roles: ["api", "consumer"], name: "api" });
      const worker = await scenario.start({ roles: ["pending-worker"], name: "worker" });
      const wallet = await scenario.wallet(serving, "100.00");
      const bet = newBet(wallet, "40.00");
      const refund = newBet(wallet, "40.00", {
        kind: "REFUND",
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const viaServing = { targets: () => [serving] };

      const early = await submitResilient(scenario, refund, keyOf(refund), viaServing);
      expect(early.status).toBe(202);
      expect((early.body as { status: string }).status).toBe("PENDING_REFERENCE");
      expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("100.00");

      const reference = await submitResilient(scenario, bet, keyOf(bet), viaServing);
      expect(reference.status).toBe(200);

      await scenario.poll(
        "o worker resolver o REFUND",
        async () => (await statusCounts(scenario.client, wallet.id))["REFUND:PROCESSED"] === 1,
        { timeoutMs: 60_000 },
      );

      expect(await statusCounts(scenario.client, wallet.id)).toEqual({
        "BET:PROCESSED": 1,
        "REFUND:PROCESSED": 1,
      });
      expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("100.00");
      expect(
        (await ledgerOf(scenario.client, wallet.id)).map((entry) => [
          entry.direction,
          entry.amount,
        ]),
      ).toEqual([
        ["CREDIT", "100.00"],
        ["DEBIT", "40.00"],
        ["CREDIT", "40.00"],
      ]);

      const eventTypes = await eventTypesOf(
        scenario.client,
        await idOf(scenario.client, wallet.id, "REFUND"),
      );
      expect(eventTypes.filter((type) => type === "WagerTransactionPendingReference")).toHaveLength(
        1,
      );
      expect(eventTypes.filter((type) => type === "WagerTransactionProcessed")).toHaveLength(1);
      expect(eventTypes.filter((type) => type === "WalletBalanceChanged")).toHaveLength(1);

      expect(worker.events("pending_worker.processed")).toHaveLength(1);
      expect(serving.events("pending_worker.processed")).toHaveLength(0);

      const replay = await submitResilient(scenario, refund, keyOf(refund), viaServing);
      expect(replay.status).toBe(200);
      expect(await ledgerEntryCount(scenario.client, wallet.id)).toBe(3);
    },
  );

  scenarioTest(
    "ROLLBACK de uma WIN que ainda não chegou (pela fila): pendente, depois a WIN, e o worker desfaz o prêmio",
    async (scenario) => {
      const serving = await scenario.start({ roles: ["api", "consumer"], name: "api" });
      const worker = await scenario.start({ roles: ["pending-worker"], name: "worker" });
      const wallet = await scenario.wallet(serving, "100.00");
      const bet = newBet(wallet, "10.00");
      const win = newBet(wallet, "30.00", {
        kind: "WIN",
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const rollback = newBet(wallet, "30.00", {
        kind: "ROLLBACK",
        referenceExternalTransactionId: win.externalTransactionId,
      });
      const viaServing = { targets: () => [serving] };

      expect((await submitResilient(scenario, bet, keyOf(bet), viaServing)).status).toBe(200);

      await sendWagerMessage(scenario.queues, rollback, { messageId: `msg-${randomUUID()}` });
      await scenario.poll(
        "o ROLLBACK ficar PENDING_REFERENCE",
        async () =>
          (await statusCounts(scenario.client, wallet.id))["ROLLBACK:PENDING_REFERENCE"] === 1,
      );
      expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("90.00");

      expect((await submitResilient(scenario, win, keyOf(win), viaServing)).status).toBe(200);
      expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("120.00");

      await scenario.poll(
        "o worker resolver o ROLLBACK",
        async () => (await statusCounts(scenario.client, wallet.id))["ROLLBACK:PROCESSED"] === 1,
        { timeoutMs: 60_000 },
      );

      expect(await statusCounts(scenario.client, wallet.id)).toEqual({
        "BET:PROCESSED": 1,
        "WIN:PROCESSED": 1,
        "ROLLBACK:PROCESSED": 1,
      });
      expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("90.00");
      expect(
        (await ledgerOf(scenario.client, wallet.id)).map((entry) => [
          entry.direction,
          entry.amount,
        ]),
      ).toEqual([
        ["CREDIT", "100.00"],
        ["DEBIT", "10.00"],
        ["CREDIT", "30.00"],
        ["DEBIT", "30.00"],
      ]);

      const eventTypes = await eventTypesOf(
        scenario.client,
        await idOf(scenario.client, wallet.id, "ROLLBACK"),
      );
      expect(eventTypes.filter((type) => type === "WagerTransactionPendingReference")).toHaveLength(
        1,
      );
      expect(worker.events("pending_worker.processed")).toHaveLength(1);
      expect(await scenario.queues.dlqDepth()).toBe(0);
      expect(await scenario.queues.inputDepth()).toBe(0);
    },
  );
});
