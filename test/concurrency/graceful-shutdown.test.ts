import { describe, expect } from "bun:test";
import { waitUntilSomeoneWaitsOnLock } from "../support/async";
import {
  ledgerEntryCount,
  newBet,
  scenarioTest,
  sendWagerMessage,
  statusCounts,
} from "../support/process-scenario";
import { walletSnapshot } from "../support/wagering-api";

const WINDOWS = process.platform === "win32";

describe("encerramento normal (SIGTERM)", () => {
  scenarioTest(
    WINDOWS
      ? "SIGTERM com uma mensagem em processamento (PULADO no Windows: não há SIGTERM gracioso; roda em Linux/macOS e no container da etapa 17)"
      : "SIGTERM com uma mensagem em processamento: termina de processá-la, apaga da fila e sai com código 0",
    async (scenario) => {
      const api = await scenario.start({ roles: ["api"], name: "api" });
      const wallet = await scenario.wallet(api, "100.00");
      const holder = await scenario.db.connect();
      await holder.query("begin");
      await holder.query("select id from wallets where id = $1 for update", [wallet.id]);

      try {
        await sendWagerMessage(scenario.queues, newBet(wallet, "30.00"));
        const consumer = await scenario.start({ roles: ["consumer"], name: "consumer" });
        await waitUntilSomeoneWaitsOnLock(scenario.client);

        consumer.signal("SIGTERM");
        await holder.query("rollback");

        expect(await consumer.waitForExit()).toBe(0);
      } finally {
        await holder.query("rollback").catch(() => undefined);
      }

      expect(await statusCounts(scenario.client, wallet.id)).toEqual({ "BET:PROCESSED": 1 });
      expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("70.00");
      expect(await ledgerEntryCount(scenario.client, wallet.id)).toBe(2);
      expect(await scenario.queues.inputDepth()).toBe(0);
      expect(await scenario.queues.dlqDepth()).toBe(0);
    },
    { skip: WINDOWS },
  );
});
