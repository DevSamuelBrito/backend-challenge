import { describe, expect } from "bun:test";
import type { Client } from "pg";
import { pendingCount, seedOutbox } from "../support/outbox";
import { type Scenario, scenarioTest } from "../support/process-scenario";

const EVENT_COUNT = 300;
const SMALL_BATCH = { OUTBOX_BATCH_SIZE: "10" };

const dueRows = () =>
  Array.from({ length: EVENT_COUNT }, () => ({ nextAttemptAt: new Date(Date.now() - 60_000) }));

async function unpublishedIds(client: Client): Promise<string[]> {
  const { rows } = await client.query("select id from outbox_messages where published_at is null");

  return rows.map((row) => row.id as string);
}

async function expectEveryRowPublishedWithoutRetries(scenario: Scenario, ids: string[]) {
  const { rows } = await scenario.client.query(
    `select count(*)::int as total,
            count(published_at)::int as published,
            (count(*) filter (where attempts <> 0))::int as retried
       from outbox_messages where id = any($1)`,
    [ids],
  );

  expect(rows[0]).toEqual({ total: ids.length, published: ids.length, retried: 0 });
}

describe("cenário 6: dois publishers sobre a mesma outbox", () => {
  scenarioTest(
    "2 processos publicam centenas de eventos pendentes: todos chegam à fila e todas as linhas ficam marcadas",
    async (scenario) => {
      const ids = await seedOutbox(scenario.client, dueRows());
      expect(await pendingCount(scenario.client)).toBe(EVENT_COUNT);

      await scenario.startMany(2, { roles: ["outbox"] });
      await scenario.poll(
        "a outbox ficar sem pendentes",
        async () => (await pendingCount(scenario.client)) === 0,
        { timeoutMs: 60_000 },
      );

      const received = await scenario.events.drain(EVENT_COUNT, 30_000);

      expect(new Set(received.map((event) => event.body.eventId))).toEqual(new Set(ids));
      await expectEveryRowPublishedWithoutRetries(scenario, ids);
    },
    { env: SMALL_BATCH },
  );

  scenarioTest(
    "o publisher A morre depois de enviar e antes de marcar; o B assume e termina sem perder nada",
    async (scenario) => {
      const ids = await seedOutbox(scenario.client, dueRows());

      const crashing = scenario.harness.spawn({
        roles: ["outbox"],
        faultPoint: "outbox.after_send_before_mark",
      });
      await crashing.waitForExit();

      expect(crashing.events("fault.crash")).toHaveLength(1);
      expect(await unpublishedIds(scenario.client)).toHaveLength(EVENT_COUNT);

      const sentBeforeCrash = await scenario.events.drain(undefined, 5_000);
      expect(sentBeforeCrash.length).toBeGreaterThan(0);

      await scenario.start({ roles: ["outbox"] });
      await scenario.poll(
        "a outbox ficar sem pendentes",
        async () => (await pendingCount(scenario.client)) === 0,
        { timeoutMs: 60_000 },
      );

      const sentAfterTakeover = await scenario.events.drain(undefined, 10_000);
      const arrived = new Set(
        [...sentBeforeCrash, ...sentAfterTakeover].map((event) => event.body.eventId),
      );

      expect(arrived).toEqual(new Set(ids));
      await expectEveryRowPublishedWithoutRetries(scenario, ids);
    },
    { env: SMALL_BATCH },
  );
});
