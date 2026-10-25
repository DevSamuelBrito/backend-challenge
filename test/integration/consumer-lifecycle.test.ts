import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { MESSAGE_QUEUE } from "../../src/modules/messaging/application/message-queue.port";
import { FAULT_INJECTOR } from "../../src/shared/application/fault-injector.port";
import { createGate, type Gate, waitUntil } from "../support/async";
import {
  CONSUMER_TEST_ENV,
  consumerOf,
  createInputQueues,
  type InputQueues,
  recordingQueue,
  wagerMessage,
} from "../support/consumer";
import { useConsumer } from "../support/consumer-scenario";
import { ScriptedFaultInjector } from "../support/outbox";
import { openWallet, wagerPayload, walletSnapshot } from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

setDefaultTimeout(40_000);

const money = (amount: string) => ({ amount, currency: "BRL" });

interface Hold {
  reached: Gate;
  release: Gate;
}

let armed: Hold | undefined;

const consumer = useConsumer(
  { CONSUMER_CONCURRENCY: "1" },
  {
    wrapUnitOfWork: (real) => ({
      run: (work) => {
        const hold = armed;
        armed = undefined;

        if (!hold) {
          return real.run(work);
        }

        return real.run(async (repositories) => {
          const result = await work(repositories);
          hold.reached.open();
          await hold.release.opened;

          return result;
        });
      },
    }),
  },
);

const holds: Hold[] = [];

function holdNextTransaction(): Hold {
  const hold = { reached: createGate(), release: createGate() };
  holds.push(hold);
  armed = hold;

  return hold;
}

afterEach(() => {
  for (const hold of holds.splice(0)) {
    hold.release.open();
  }
  armed = undefined;
});

describe("consumidor SQS: encerramento gracioso", () => {
  test("espera a mensagem em processamento terminar e devolve imediatamente as que ainda não começaram", async () => {
    const wallets = await Promise.all([
      consumer.wallet("100.00"),
      consumer.wallet("100.00"),
      consumer.wallet("100.00"),
    ]);
    for (const wallet of wallets) {
      await consumer.send(consumer.payload(wallet, { money: money("30.00") }));
    }
    const hold = holdNextTransaction();

    consumer.start();
    await hold.reached.opened;

    const batchSize = consumer.queue.received.length;
    expect(batchSize).toBeGreaterThanOrEqual(2);

    let stopped = false;
    const stopping = consumer.stop().then(() => {
      stopped = true;
    });

    await waitUntil(
      () =>
        consumer.queue.visibilityChanges.filter((change) => change.seconds === 0).length >=
        batchSize - 1,
      "as mensagens não iniciadas voltarem à fila",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(stopped).toBe(false);
    expect(consumer.queue.deleted).toHaveLength(0);

    hold.release.open();
    await stopping;

    expect(stopped).toBe(true);
    expect(consumer.queue.deleted).toHaveLength(1);
    const balances = await consumer.balances(wallets);
    expect(balances.filter((balance) => balance === "70.00")).toHaveLength(1);
    expect(balances.filter((balance) => balance === "100.00")).toHaveLength(batchSize - 1);
    expect(await consumer.queues.inputDepth()).toBe(batchSize - 1);

    consumer.start();
    await consumer.settled();

    expect(await consumer.balances(wallets)).toEqual(["70.00", "70.00", "70.00"]);
    expect(await consumer.queues.dlqDepth()).toBe(0);
  });

  test("as mensagens devolvidas não perdem tentativas: voltam sem esperar o visibility timeout", async () => {
    const wallets = await Promise.all([consumer.wallet("100.00"), consumer.wallet("100.00")]);
    for (const wallet of wallets) {
      await consumer.send(consumer.payload(wallet, { money: money("10.00") }));
    }
    const hold = holdNextTransaction();

    consumer.start();
    await hold.reached.opened;
    const stopping = consumer.stop();
    await waitUntil(
      () => consumer.queue.visibilityChanges.some((change) => change.seconds === 0),
      "uma mensagem ser devolvida",
    );
    hold.release.open();
    await stopping;

    const startedAt = Date.now();
    consumer.start();
    await consumer.settled();

    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  test("encerrar sem nada em andamento é rápido e idempotente", async () => {
    consumer.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const startedAt = Date.now();
    await consumer.stop();
    await consumer.stop();

    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});

describe("consumidor SQS: papel consumer", () => {
  let api: WalletApi | undefined;
  let queues: InputQueues | undefined;

  afterEach(async () => {
    if (api) {
      await consumerOf(api).stop();
      await api.close();
      api = undefined;
    }
    await queues?.close();
    queues = undefined;
  });

  async function boot(roles: string) {
    queues = await createInputQueues();
    const env = {
      ...CONSUMER_TEST_ENV,
      SQS_TRANSACTIONS_QUEUE: queues.inputName,
      SQS_TRANSACTIONS_DLQ: queues.dlqName,
      APP_ROLES: roles,
    };
    const queue = recordingQueue(env);
    api = await startWalletApi({
      env,
      providers: [
        { token: MESSAGE_QUEUE, value: queue },
        { token: FAULT_INJECTOR, value: new ScriptedFaultInjector() },
      ],
    });
    const wallet = await openWallet(api.http, "100.00");
    await queues.send(wagerMessage(wagerPayload(wallet, { money: money("30.00") })));

    return { queue, wallet };
  }

  test("com o papel consumer, a aplicação consome sozinha ao subir", async () => {
    const { wallet } = await boot("api,consumer");
    const current = api as WalletApi;

    await waitUntil(
      async () => (await walletSnapshot(current.db.client, wallet.id)).balance === "70.00",
      "a mensagem ser consumida",
      20_000,
    );
  });

  test("sem o papel consumer, nada é consumido", async () => {
    const { queue } = await boot("api");

    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(queue.received).toHaveLength(0);
    expect(await (queues as InputQueues).inputDepth()).toBe(1);
  });

  test("desligar a aplicação para o consumidor e devolve a conexão sem mensagens em voo", async () => {
    await boot("api,consumer");
    const current = api as WalletApi;
    await waitUntil(
      async () => (await (queues as InputQueues).inputDepth()) === 0,
      "a mensagem ser consumida",
      20_000,
    );

    const startedAt = Date.now();
    await current.app.close();

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await current.db.close();
    api = undefined;
  });
});
