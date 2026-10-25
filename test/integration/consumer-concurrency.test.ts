import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { QueueMessage } from "../../src/modules/messaging/application/message-queue.port";
import { MESSAGE_QUEUE } from "../../src/modules/messaging/application/message-queue.port";
import { WagerTransactionMessageHandler } from "../../src/modules/wagering/messaging/wager-transaction-message.handler";
import { FAULT_INJECTOR } from "../../src/shared/application/fault-injector.port";
import { waitUntil } from "../support/async";
import {
  CONSUMER_TEST_ENV,
  consumerOf,
  createInputQueues,
  type InputQueues,
  type RecordingQueue,
  recordingQueue,
  wagerMessage,
} from "../support/consumer";
import { expectInvariants } from "../support/invariants";
import { ScriptedFaultInjector } from "../support/outbox";
import { workerOf } from "../support/pending-worker";
import {
  type OpenedWallet,
  openWallet,
  type WagerPayload,
  wagerPayload,
  walletSnapshot,
} from "../support/wagering-api";
import { type Cluster, startCluster } from "../support/wallet-api";

setDefaultTimeout(120_000);

const money = (amount: string) => ({ amount, currency: "BRL" });

describe("consumidores concorrentes: 3 instâncias sobre a mesma fila e o mesmo banco", () => {
  let cluster: Cluster;
  let queues: InputQueues;
  let queue: RecordingQueue;

  beforeAll(async () => {
    queues = await createInputQueues();
    const env = {
      ...CONSUMER_TEST_ENV,
      CONSUMER_CONCURRENCY: "3",
      SQS_TRANSACTIONS_QUEUE: queues.inputName,
      SQS_TRANSACTIONS_DLQ: queues.dlqName,
    };
    queue = recordingQueue(env);
    cluster = await startCluster(3, {
      env,
      providers: [
        { token: MESSAGE_QUEUE, value: queue },
        { token: FAULT_INJECTOR, value: new ScriptedFaultInjector() },
      ],
    });
  });

  afterAll(async () => {
    await Promise.all(cluster.instances.map((instance) => consumerOf(instance).stop()));
    await cluster.close();
    await queues.close();
  });

  const http = () => cluster.instances[0]?.http as (typeof cluster.http)[number];
  const client = () => cluster.db.client;

  const balanceOf = async (wallet: OpenedWallet) =>
    (await walletSnapshot(client(), wallet.id)).balance;

  const transactionsOf = async (wallet: OpenedWallet) => {
    const { rows } = await client().query(
      `select kind, status, failure_code from wager_transactions
        where wallet_id = $1 and kind <> 'OPENING' order by kind, created_at`,
      [wallet.id],
    );

    return rows as { kind: string; status: string; failure_code: string | null }[];
  };

  const ledgerCount = async (wallet: OpenedWallet) => {
    const { rows } = await client().query(
      "select count(*)::int as total from wallet_ledger_entries where wallet_id = $1 and wallet_version > 1",
      [wallet.id],
    );

    return rows[0].total as number;
  };

  const handlerOf = (index: number) =>
    cluster.instances[index % cluster.instances.length]?.app.get(WagerTransactionMessageHandler, {
      strict: false,
    }) as WagerTransactionMessageHandler;

  const fakeMessage = (body: unknown): QueueMessage => ({
    sqsMessageId: randomUUID(),
    receiptHandle: "irrelevante",
    body: JSON.stringify(body),
    groupId: undefined,
    deduplicationId: undefined,
    receiveCount: 1,
  });

  test("carga mista com duplicadas, fora de ordem e disputa de saldo: invariantes ok e nenhuma mensagem perdida", async () => {
    const outbound: { message: unknown; groupId: string; deduplicationId?: string }[] = [];
    const messageIds = new Set<string>();

    const push = (
      payload: WagerPayload,
      overrides: Parameters<typeof wagerMessage>[1] = {},
      options: { groupId?: string; redelivery?: boolean } = {},
    ) => {
      const message = wagerMessage(payload, overrides);
      messageIds.add(message.messageId);
      outbound.push({
        message,
        groupId: options.groupId ?? payload.walletId,
        ...(options.redelivery && { deduplicationId: randomUUID() }),
      });

      return message;
    };

    const contested = await openWallet(http(), "100.00");
    push(wagerPayload(contested, { money: money("80.00") }));
    push(wagerPayload(contested, { money: money("80.00") }));

    const hammered = await openWallet(http(), "100.00");
    const sameBet = wagerPayload(hammered, { money: money("30.00") });
    for (let index = 0; index < 50; index += 1) {
      push(sameBet, {}, { groupId: `grupo-${index}` });
    }

    const reversed = await openWallet(http(), "100.00");
    const betToReverse = wagerPayload(reversed, { money: money("30.00") });
    push(
      wagerPayload(reversed, {
        kind: "REFUND",
        money: money("30.00"),
        referenceExternalTransactionId: betToReverse.externalTransactionId,
      }),
    );
    push(betToReverse);

    const regulars: OpenedWallet[] = [];
    for (let index = 0; index < 20; index += 1) {
      const wallet = await openWallet(http(), "100.00");
      regulars.push(wallet);
      const bet = wagerPayload(wallet, { money: money("10.00") });
      const win = wagerPayload(wallet, {
        kind: "WIN",
        money: money("25.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      push(bet);
      push(bet);
      push(win);
      const redelivered = push(win);
      outbound.push({
        message: redelivered,
        groupId: wallet.id,
        deduplicationId: randomUUID(),
      });
      push(wagerPayload(wallet, { kind: "LOSS", money: money("5.00") }));
    }

    const shuffled = shuffle(outbound, 20260724);
    for (const entry of shuffled) {
      await queues.send(entry.message, {
        groupId: entry.groupId,
        ...(entry.deduplicationId && { deduplicationId: entry.deduplicationId }),
      });
    }

    for (const instance of cluster.instances) {
      consumerOf(instance).start();
    }
    await waitUntil(
      async () => (await queues.inputDepth()) === 0,
      "a fila de entrada esvaziar",
      90_000,
    );

    const worker = workerOf(cluster.instances[0] as (typeof cluster.instances)[number]);
    for (let round = 0; round < 10; round += 1) {
      const { rows } = await client().query(
        "select count(*)::int as total from wager_transactions where status = 'PENDING_REFERENCE'",
      );

      if (rows[0].total === 0) {
        break;
      }

      await worker.tick(new Date(Date.now() + 3_600_000 * (round + 1)));
    }

    expect(await queues.dlqDepth()).toBe(0);
    expect(await queues.inputDepth()).toBe(0);

    expect(await balanceOf(contested)).toBe("20.00");
    expect((await transactionsOf(contested)).map((t) => [t.status, t.failure_code]).sort()).toEqual(
      [
        ["PROCESSED", null],
        ["REJECTED", "INSUFFICIENT_FUNDS"],
      ],
    );
    expect(await ledgerCount(contested)).toBe(1);

    expect(await balanceOf(hammered)).toBe("70.00");
    expect(await transactionsOf(hammered)).toHaveLength(1);
    expect(await ledgerCount(hammered)).toBe(1);

    expect(await balanceOf(reversed)).toBe("100.00");
    expect((await transactionsOf(reversed)).map((t) => [t.kind, t.status])).toEqual([
      ["BET", "PROCESSED"],
      ["REFUND", "PROCESSED"],
    ]);

    for (const wallet of regulars) {
      expect(await balanceOf(wallet)).toBe("115.00");
      expect((await transactionsOf(wallet)).map((t) => [t.kind, t.status])).toEqual([
        ["BET", "PROCESSED"],
        ["LOSS", "PROCESSED"],
        ["WIN", "PROCESSED"],
      ]);
      expect(await ledgerCount(wallet)).toBe(2);
    }

    const { rows } = await client().query(
      "select count(*)::int as total from inbox_messages where message_id = any($1)",
      [[...messageIds]],
    );
    expect(rows[0].total).toBe(messageIds.size);
    await expectInvariants(client());
  });

  test("a mesma mensagem entregue 50 vezes ao mesmo tempo, espalhada pelas 3 instâncias: um único efeito", async () => {
    const wallet = await openWallet(http(), "100.00");
    const message = wagerMessage(wagerPayload(wallet, { money: money("30.00") }));

    const dispositions = await Promise.all(
      Array.from({ length: 50 }, (_, index) => handlerOf(index).handle(fakeMessage(message))),
    );

    expect(dispositions.every((disposition) => disposition.kind === "ack")).toBe(true);
    expect(await balanceOf(wallet)).toBe("70.00");
    expect(await transactionsOf(wallet)).toHaveLength(1);
    expect(await ledgerCount(wallet)).toBe(1);
    const { rows } = await client().query(
      "select count(*)::int as total from inbox_messages where message_id = $1",
      [message.messageId],
    );
    expect(rows[0].total).toBe(1);
    await expectInvariants(client());
  });

  test("50 mensagens com messageIds diferentes e o mesmo conteúdo ao mesmo tempo: um único efeito, 49 replays", async () => {
    const wallet = await openWallet(http(), "100.00");
    const payload = wagerPayload(wallet, { money: money("30.00") });

    const dispositions = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        handlerOf(index).handle(fakeMessage(wagerMessage(payload))),
      ),
    );

    expect(dispositions.every((disposition) => disposition.kind === "ack")).toBe(true);
    expect(await balanceOf(wallet)).toBe("70.00");
    expect(await transactionsOf(wallet)).toHaveLength(1);
    expect(await ledgerCount(wallet)).toBe(1);
    await expectInvariants(client());
  });

  test("o mesmo messageId com dois conteúdos ao mesmo tempo: um conteúdo vence e o outro vai para a DLQ", async () => {
    const wallet = await openWallet(http(), "100.00");
    const messageId = `msg-${randomUUID()}`;
    const small = wagerMessage(wagerPayload(wallet, { money: money("10.00") }), { messageId });
    const large = wagerMessage(wagerPayload(wallet, { money: money("40.00") }), { messageId });

    const dispositions = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        handlerOf(index).handle(fakeMessage(index % 2 === 0 ? small : large)),
      ),
    );

    const rejected = dispositions.filter((disposition) => disposition.kind === "dead-letter");
    expect(rejected.length).toBeGreaterThan(0);
    expect(
      rejected.every(
        (disposition) =>
          disposition.kind === "dead-letter" && disposition.reason === "INBOX_PAYLOAD_MISMATCH",
      ),
    ).toBe(true);
    expect(dispositions.filter((disposition) => disposition.kind === "retry")).toHaveLength(0);
    expect(await transactionsOf(wallet)).toHaveLength(1);
    expect(await ledgerCount(wallet)).toBe(1);
    await expectInvariants(client());
  });
});

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }

  return copy;
}
