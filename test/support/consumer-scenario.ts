import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { MESSAGE_QUEUE } from "../../src/modules/messaging/application/message-queue.port";
import { FAULT_INJECTOR } from "../../src/shared/application/fault-injector.port";
import { waitUntil } from "./async";
import {
  CONSUMER_TEST_ENV,
  consumerOf,
  createInputQueues,
  type InputQueues,
  type RecordingQueue,
  recordingQueue,
  type SendOptions,
  wagerMessage,
} from "./consumer";
import { expectInvariants } from "./invariants";
import { ScriptedFaultInjector } from "./outbox";
import { tableCounts } from "./table-counts";
import {
  eventsOfTransaction,
  ledgerOf,
  type OpenedWallet,
  openWallet,
  type WagerPayload,
  wagerPayload,
  walletSnapshot,
} from "./wagering-api";
import { startWalletApi, type WalletApi, type WalletApiOptions } from "./wallet-api";

export function useConsumer(
  env: Record<string, string> = {},
  options: Omit<WalletApiOptions, "env" | "providers"> = {},
) {
  let api: WalletApi;
  let queues: InputQueues;
  let queue: RecordingQueue;
  const faults = new ScriptedFaultInjector();

  beforeAll(async () => {
    queues = await createInputQueues();
    const queueEnv = {
      ...CONSUMER_TEST_ENV,
      SQS_TRANSACTIONS_QUEUE: queues.inputName,
      SQS_TRANSACTIONS_DLQ: queues.dlqName,
      ...env,
    };
    queue = recordingQueue(queueEnv);
    api = await startWalletApi({
      ...options,
      env: queueEnv,
      providers: [
        { token: MESSAGE_QUEUE, value: queue },
        { token: FAULT_INJECTOR, value: faults },
      ],
    });
  });

  afterAll(async () => {
    await consumerOf(api).stop();
    await api.close();
    await queues.close();
  });

  beforeEach(async () => {
    await queues.purge();
    queue.reset();
    faults.disarm();
    faults.reached.length = 0;
  });

  afterEach(async () => {
    await consumerOf(api).stop();
    await expectInvariants(api.db.client);
  });

  const scenario = {
    faults,
    get api() {
      return api;
    },
    get client() {
      return api.db.client;
    },
    get queues() {
      return queues;
    },
    get queue() {
      return queue;
    },

    start: () => consumerOf(api).start(),
    stop: () => consumerOf(api).stop(),

    wallet: (balance = "100.00", currency = "BRL"): Promise<OpenedWallet> =>
      openWallet(api.http, balance, currency),

    payload: (wallet: OpenedWallet, overrides: Partial<WagerPayload> = {}) =>
      wagerPayload(wallet, overrides),

    message: wagerMessage,

    async send(
      payload: WagerPayload,
      overrides: Parameters<typeof wagerMessage>[1] = {},
      sendOptions: SendOptions = {},
    ) {
      const message = wagerMessage(payload, overrides);
      await queues.send(message, sendOptions);

      return message;
    },

    async settled(timeoutMs = 20_000): Promise<void> {
      await waitUntil(
        async () => (await queues.inputDepth()) === 0,
        "a fila de entrada esvaziar",
        timeoutMs,
      );
    },

    async balance(wallet: OpenedWallet): Promise<string> {
      return (await walletSnapshot(api.db.client, wallet.id)).balance;
    },

    async balances(wallets: readonly OpenedWallet[]): Promise<string[]> {
      const balances: string[] = [];

      for (const wallet of wallets) {
        balances.push((await walletSnapshot(api.db.client, wallet.id)).balance);
      }

      return balances;
    },

    async movements(wallet: OpenedWallet) {
      return (await ledgerOf(api.db.client, wallet.id)).slice(1).map((entry) => ({
        direction: entry.direction,
        amount: entry.amount,
        balanceAfter: entry.balance_after,
      }));
    },

    async eventTypes(transactionId: string): Promise<string[]> {
      return (await eventsOfTransaction(api.db.client, transactionId)).map(
        (event) => event.event_type,
      );
    },

    async transactionsOf(wallet: OpenedWallet) {
      const { rows } = await api.db.client.query(
        `select id, kind, status, failure_code, amount::text as amount, idempotency_key
           from wager_transactions
          where wallet_id = $1 and kind <> 'OPENING'
          order by created_at, id`,
        [wallet.id],
      );

      return rows as {
        id: string;
        kind: string;
        status: string;
        failure_code: string | null;
        amount: string;
        idempotency_key: string;
      }[];
    },

    async inboxCount(messageId?: string): Promise<number> {
      const { rows } =
        messageId === undefined
          ? await api.db.client.query("select count(*)::int as total from inbox_messages")
          : await api.db.client.query(
              "select count(*)::int as total from inbox_messages where message_id = $1",
              [messageId],
            );

      return rows[0].total as number;
    },

    counts: () => tableCounts(api.db.client),
  };

  return scenario;
}
