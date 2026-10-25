import { describe, expect } from "bun:test";
import type { Client } from "pg";
import {
  ledgerEntryCount,
  newBet,
  scenarioTest,
  sendWagerMessage,
  statusCounts,
  sumMetric,
  transactionCount,
} from "../support/process-scenario";
import { walletSnapshot } from "../support/wagering-api";

async function inboxRows(client: Client, messageId: string): Promise<number> {
  const { rows } = await client.query(
    "select count(*)::int as total from inbox_messages where message_id = $1",
    [messageId],
  );

  return rows[0].total as number;
}

describe("cenário 5: o worker morre depois do commit e antes do ack", () => {
  scenarioTest(
    "a mensagem volta, o inbox deduplica e o efeito aparece uma única vez",
    async (scenario) => {
      const api = await scenario.start({ roles: ["api"] });
      const wallet = await scenario.wallet(api, "100.00");
      const bet = newBet(wallet, "30.00");
      const message = await sendWagerMessage(scenario.queues, bet);

      const crashing = await scenario.start({
        roles: ["consumer"],
        faultPoint: "consumer.after_commit_before_ack",
      });
      await crashing.waitForExit();

      expect(crashing.events("fault.crash")).toHaveLength(1);
      expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("70.00");
      expect(await statusCounts(scenario.client, wallet.id)).toEqual({ "BET:PROCESSED": 1 });
      expect(await ledgerEntryCount(scenario.client, wallet.id)).toBe(2);
      expect(await scenario.queues.inputDepth()).toBe(1);
      expect(await inboxRows(scenario.client, message.messageId)).toBe(1);

      const survivor = await scenario.start({ roles: ["consumer"] });
      await scenario.poll(
        "a mensagem ser reentregue, deduplicada e removida da fila",
        async () => (await scenario.queues.inputDepth()) === 0,
      );

      expect(survivor.events("wager.message_already_processed")).toHaveLength(1);
      expect(await sumMetric([survivor], "wager_duplicates_total", { type: "inbox_message" })).toBe(
        1,
      );
      expect((await walletSnapshot(scenario.client, wallet.id)).balance).toBe("70.00");
      expect(await ledgerEntryCount(scenario.client, wallet.id)).toBe(2);
      expect(await transactionCount(scenario.client, wallet.id)).toBe(1);
      expect(await scenario.queues.dlqDepth()).toBe(0);
      expect(await inboxRows(scenario.client, message.messageId)).toBe(1);
    },
  );
});
