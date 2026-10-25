import { describe, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ALL_ROLES,
  keyOf,
  newBet,
  pick,
  type Scenario,
  scenarioTest,
  sendWagerMessage,
  statusCounts,
  submitResilient,
  transactionCount,
} from "../support/process-scenario";
import type { OpenedWallet, WagerPayload } from "../support/wagering-api";
import { ledgerOf, walletSnapshot } from "../support/wagering-api";

const BETS_PER_WALLET = 12;
const REFUNDS_PER_WALLET = 4;
const FIRST_DUPLICATED_BET = 4;
const LAST_DUPLICATED_BET = 6;
const SAME_MESSAGE_BET = 7;
const SQS_WALLETS = 3;
const HTTP_WALLETS = 3;
const INITIAL = "1000.00";
const STAKE = "10.00";
const BALANCE_WITH_REFUNDS = "920.00";
const BALANCE_WITHOUT_REFUNDS = "880.00";

const range = (count: number) => Array.from({ length: count }, (_, index) => index);

interface WalletPlan {
  wallet: OpenedWallet;
  bets: WagerPayload[];
  refunds: WagerPayload[];
}

function planFor(wallet: OpenedWallet, refunds: number): WalletPlan {
  const bets = range(BETS_PER_WALLET).map(() => newBet(wallet, STAKE));

  return {
    wallet,
    bets,
    refunds: range(refunds).map((index) =>
      newBet(wallet, STAKE, {
        kind: "REFUND",
        referenceExternalTransactionId: (bets[index] as WagerPayload).externalTransactionId,
      }),
    ),
  };
}

const betAt = (plan: WalletPlan, index: number) => plan.bets[index] as WagerPayload;
const refundAt = (plan: WalletPlan, index: number) => plan.refunds[index] as WagerPayload;

async function enqueue(scenario: Scenario, plan: WalletPlan): Promise<void> {
  const { queues } = scenario;

  for (const index of range(REFUNDS_PER_WALLET)) {
    await sendWagerMessage(queues, refundAt(plan, index));
    await sendWagerMessage(queues, betAt(plan, index));
  }

  for (const index of range(BETS_PER_WALLET).slice(REFUNDS_PER_WALLET)) {
    await sendWagerMessage(queues, betAt(plan, index));
  }

  for (let index = FIRST_DUPLICATED_BET; index <= LAST_DUPLICATED_BET; index++) {
    await sendWagerMessage(queues, betAt(plan, index));
  }

  const repeatedMessageId = `msg-${randomUUID()}`;
  await sendWagerMessage(queues, betAt(plan, SAME_MESSAGE_BET), { messageId: repeatedMessageId });
  await sendWagerMessage(queues, betAt(plan, SAME_MESSAGE_BET), { messageId: repeatedMessageId });
}

async function sendOverHttp(scenario: Scenario, plan: WalletPlan): Promise<void> {
  const submit = async (payload: WagerPayload, accepted: number[]) => {
    const result = await submitResilient(scenario, payload, keyOf(payload));

    if (!accepted.includes(result.status)) {
      throw new Error(`${payload.kind} respondeu ${result.status}: ${JSON.stringify(result.body)}`);
    }
  };

  for (const index of range(BETS_PER_WALLET)) {
    if (index < plan.refunds.length) {
      await submit(refundAt(plan, index), [200, 202]);
    }

    await submit(betAt(plan, index), [200]);

    if (index >= FIRST_DUPLICATED_BET && index <= LAST_DUPLICATED_BET) {
      await Promise.all([submit(betAt(plan, index), [200]), submit(betAt(plan, index), [200])]);
    }
  }
}

async function queryCount(scenario: Scenario, sql: string): Promise<number> {
  const { rows } = await scenario.client.query(sql);

  return rows[0].total as number;
}

describe("cenário 8: reinício do serviço no meio de uma carga, com consistência final", () => {
  scenarioTest(
    "mata os 3 processos com kill forçado no meio da carga, sobe 3 novos e o estado final é o calculado a priori",
    async (scenario) => {
      const firstGeneration = await scenario.startMany(3, { roles: ALL_ROLES });
      const through = pick(firstGeneration, 0);
      const wallets = await Promise.all(
        range(SQS_WALLETS + HTTP_WALLETS).map(() => scenario.wallet(through, INITIAL)),
      );
      const poisoned = await scenario.wallet(through, INITIAL);

      const viaSqs = wallets
        .slice(0, SQS_WALLETS)
        .map((wallet) => planFor(wallet, REFUNDS_PER_WALLET));
      const viaHttp = wallets
        .slice(SQS_WALLETS)
        .map((wallet) => planFor(wallet, REFUNDS_PER_WALLET));
      const poison = planFor(poisoned, 0);

      const expectedTransactions =
        (SQS_WALLETS + HTTP_WALLETS) * (BETS_PER_WALLET + REFUNDS_PER_WALLET) + BETS_PER_WALLET;

      const holder = await scenario.db.connect();
      await holder.query("begin");
      await holder.query("select id from wallets where id = $1 for update", [poisoned.id]);

      let loadError: unknown;
      const loads = Promise.all([
        ...viaSqs.map((plan) => enqueue(scenario, plan)),
        ...viaHttp.map((plan) => sendOverHttp(scenario, plan)),
        sendOverHttp(scenario, poison),
      ]).catch((error: unknown) => {
        loadError = error;
      });
      let loadsFinished = false;
      void loads.then(() => {
        loadsFinished = true;
      });

      const oneThird = Math.ceil(expectedTransactions / 3);
      await scenario.poll(
        "pelo menos um terço das transações gravadas",
        async () => (await transactionCount(scenario.client)) >= oneThird,
        { timeoutMs: 60_000 },
      );

      const recordedAtKill = await transactionCount(scenario.client);
      await scenario.harness.killAll();
      expect(firstGeneration.every((child) => !child.alive)).toBe(true);
      expect(recordedAtKill).toBeGreaterThanOrEqual(oneThird);
      expect(recordedAtKill).toBeLessThan(expectedTransactions);

      await holder.query("rollback");

      await scenario.startMany(3, { roles: ALL_ROLES });
      await scenario.poll(
        "a carga drenar: fila vazia, nada pendente de referência e outbox sem pendentes",
        async () =>
          loadsFinished &&
          (await scenario.queues.inputDepth()) === 0 &&
          (await transactionCount(scenario.client)) === expectedTransactions &&
          (await queryCount(
            scenario,
            "select count(*)::int as total from wager_transactions where status in ('PENDING', 'PENDING_REFERENCE')",
          )) === 0 &&
          (await queryCount(
            scenario,
            "select count(*)::int as total from outbox_messages where published_at is null",
          )) === 0,
        { timeoutMs: 150_000, intervalMs: 200 },
      );

      expect(loadError).toBeUndefined();

      for (const plan of [...viaSqs, ...viaHttp]) {
        expect((await walletSnapshot(scenario.client, plan.wallet.id)).balance).toBe(
          BALANCE_WITH_REFUNDS,
        );
        expect(await statusCounts(scenario.client, plan.wallet.id)).toEqual({
          "BET:PROCESSED": BETS_PER_WALLET,
          "REFUND:PROCESSED": REFUNDS_PER_WALLET,
        });
        expect((await ledgerOf(scenario.client, plan.wallet.id)).length).toBe(
          1 + BETS_PER_WALLET + REFUNDS_PER_WALLET,
        );
      }

      expect((await walletSnapshot(scenario.client, poisoned.id)).balance).toBe(
        BALANCE_WITHOUT_REFUNDS,
      );
      expect(await statusCounts(scenario.client, poisoned.id)).toEqual({
        "BET:PROCESSED": BETS_PER_WALLET,
      });
      expect((await ledgerOf(scenario.client, poisoned.id)).length).toBe(1 + BETS_PER_WALLET);

      expect(
        await queryCount(
          scenario,
          `select count(*)::int as total from (
             select provider_id, external_transaction_id from wager_transactions
              group by 1, 2 having count(*) > 1) repeated`,
        ),
      ).toBe(0);
      expect(
        await queryCount(
          scenario,
          `select count(*)::int as total from (
             select transaction_id from wallet_ledger_entries
              group by 1 having count(*) > 1) repeated`,
        ),
      ).toBe(0);

      const ledgerEntries = await queryCount(
        scenario,
        "select count(*)::int as total from wallet_ledger_entries",
      );
      expect(ledgerEntries).toBe(
        (SQS_WALLETS + HTTP_WALLETS) * (1 + BETS_PER_WALLET + REFUNDS_PER_WALLET) +
          1 +
          BETS_PER_WALLET,
      );
      expect(
        await queryCount(
          scenario,
          "select count(*)::int as total from outbox_messages where event_type = 'WalletBalanceChanged'",
        ),
      ).toBe(ledgerEntries);

      const { rows: outboxRows } = await scenario.client.query("select id from outbox_messages");
      const outboxIds = new Set(outboxRows.map((row) => row.id as string));
      const published = await scenario.events.drain(outboxIds.size, 60_000);

      expect(new Set(published.map((event) => event.body.eventId))).toEqual(outboxIds);
      expect(await scenario.queues.dlqDepth()).toBe(0);
    },
    { timeoutMs: 240_000, env: { DB_LOCK_TIMEOUT_MS: "2000" } },
  );
});
