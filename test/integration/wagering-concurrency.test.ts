import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { HttpClient, HttpResult } from "../support/http";
import { expectInvariants } from "../support/invariants";
import { tableCounts } from "../support/table-counts";
import {
  eventsOfTransaction,
  keyFor,
  ledgerOf,
  openWallet,
  submit,
  transactionsOf,
  wagerPayload,
  walletSnapshot,
} from "../support/wagering-api";
import { type Cluster, startCluster } from "../support/wallet-api";

const INSTANCES = 3;
const money = (amount: string, currency = "BRL") => ({ amount, currency });

interface Outcome {
  transactionId: string;
  status: string;
  failureCode?: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
}

const outcomeOf = (response: HttpResult) => response.body as Outcome;
const statuses = (responses: HttpResult[]) => responses.map((response) => response.status);
const count = (values: unknown[], expected: unknown) =>
  values.filter((value) => value === expected).length;

describe(`concorrência real: ${INSTANCES} instâncias da aplicação no mesmo banco (HTTP em paralelo)`, () => {
  let cluster: Cluster;

  beforeAll(async () => {
    cluster = await startCluster(INSTANCES);
  });

  afterAll(async () => {
    await cluster.close();
  });

  afterEach(async () => {
    await expectInvariants(cluster.db.client);
  });

  const http = (index: number): HttpClient => cluster.http[index % INSTANCES] as HttpClient;
  const client = () => cluster.db.client;

  test("as instâncias são processos de aplicação distintos, com pools de conexão separados", () => {
    const urls = cluster.instances.map((instance) => instance.url);

    expect(new Set(urls).size).toBe(INSTANCES);
  });

  describe("a) saldo 100.00 e 2 BETs de 80.00 simultâneas", () => {
    test("em 10 rodadas: exatamente 1 PROCESSED e 1 REJECTED, saldo 20.00 e um único débito", async () => {
      for (let round = 0; round < 10; round++) {
        const wallet = await openWallet(http(round), "100.00");
        const first = wagerPayload(wallet, { money: money("80.00") });
        const second = wagerPayload(wallet, { money: money("80.00") });

        const responses = await Promise.all([
          submit(http(round), first, keyFor(first)),
          submit(http(round + 1), second, keyFor(second)),
        ]);

        expect(statuses(responses).sort()).toEqual([200, 422]);

        const processed = outcomeOf(
          responses.find((response) => response.status === 200) as HttpResult,
        );
        const rejected = outcomeOf(
          responses.find((response) => response.status === 422) as HttpResult,
        );

        expect(processed).toMatchObject({
          status: "PROCESSED",
          balance: money("20.00"),
          idempotentReplay: false,
        });
        expect(rejected).toMatchObject({
          status: "REJECTED",
          failureCode: "INSUFFICIENT_FUNDS",
          balance: money("20.00"),
          idempotentReplay: false,
        });

        expect(await walletSnapshot(client(), wallet.id)).toEqual({ balance: "20.00", version: 2 });

        const ledger = await ledgerOf(client(), wallet.id);
        expect(ledger.filter((entry) => entry.direction === "DEBIT")).toHaveLength(1);
        expect(ledger).toHaveLength(2);
        expect(ledger[1]?.transaction_id).toBe(processed.transactionId);

        const stored = await transactionsOf(client(), wallet.id);
        expect(stored.map((row) => row.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
        expect(stored.find((row) => row.status === "REJECTED")).toMatchObject({
          failure_code: "INSUFFICIENT_FUNDS",
          balance_after_amount: "20.00",
        });

        expect(
          (await eventsOfTransaction(client(), rejected.transactionId)).map(
            (event) => event.event_type,
          ),
        ).toEqual(["WagerTransactionRejected"]);
        expect(
          (await eventsOfTransaction(client(), processed.transactionId)).map(
            (event) => event.event_type,
          ),
        ).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
      }
    });

    test("5 apostas de 30.00 sobre 100.00, todas ao mesmo tempo: só 3 cabem", async () => {
      const wallet = await openWallet(http(0), "100.00");
      const bets = Array.from({ length: 5 }, () => wagerPayload(wallet, { money: money("30.00") }));

      const responses = await Promise.all(
        bets.map((bet, index) => submit(http(index), bet, keyFor(bet))),
      );

      expect(count(statuses(responses), 200)).toBe(3);
      expect(count(statuses(responses), 422)).toBe(2);
      expect(await walletSnapshot(client(), wallet.id)).toEqual({ balance: "10.00", version: 4 });
    });
  });

  describe("b) a MESMA transação 50 vezes em paralelo, entre as instâncias", () => {
    test("BET: 1 execução e 49 replays, um único débito, mesmo resultado para todos", async () => {
      const wallet = await openWallet(http(0), "100.00");
      const bet = wagerPayload(wallet, { money: money("10.00") });
      const key = keyFor(bet);

      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => submit(http(index), bet, key)),
      );

      expect(statuses(responses)).toEqual(Array(50).fill(200));

      const outcomes = responses.map(outcomeOf);
      expect(
        count(
          outcomes.map((outcome) => outcome.idempotentReplay),
          false,
        ),
      ).toBe(1);
      expect(
        count(
          outcomes.map((outcome) => outcome.idempotentReplay),
          true,
        ),
      ).toBe(49);
      expect(new Set(outcomes.map((outcome) => outcome.transactionId)).size).toBe(1);
      expect(outcomes.every((outcome) => outcome.balance.amount === "90.00")).toBe(true);

      expect(await walletSnapshot(client(), wallet.id)).toEqual({ balance: "90.00", version: 2 });
      expect(
        (await ledgerOf(client(), wallet.id)).filter((entry) => entry.direction === "DEBIT"),
      ).toHaveLength(1);
      expect(await transactionsOf(client(), wallet.id)).toHaveLength(1);
      expect(
        (await eventsOfTransaction(client(), outcomes[0]?.transactionId as string)).map(
          (event) => event.event_type,
        ),
      ).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    });

    test("WIN: 1 crédito, 49 replays", async () => {
      const wallet = await openWallet(http(0), "100.00");
      const win = wagerPayload(wallet, { kind: "WIN", money: money("25.00") });

      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => submit(http(index), win, keyFor(win))),
      );

      expect(statuses(responses)).toEqual(Array(50).fill(200));
      expect(
        count(
          responses.map((response) => outcomeOf(response).idempotentReplay),
          true,
        ),
      ).toBe(49);
      expect(await walletSnapshot(client(), wallet.id)).toEqual({ balance: "125.00", version: 2 });
    });

    test("LOSS: 1 transação, 49 replays, nenhum lançamento", async () => {
      const wallet = await openWallet(http(0), "100.00");
      const loss = wagerPayload(wallet, { kind: "LOSS", money: money("25.00") });

      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => submit(http(index), loss, keyFor(loss))),
      );

      expect(statuses(responses)).toEqual(Array(50).fill(200));
      expect(
        count(
          responses.map((response) => outcomeOf(response).idempotentReplay),
          true,
        ),
      ).toBe(49);
      expect(await ledgerOf(client(), wallet.id)).toHaveLength(1);
      expect(await transactionsOf(client(), wallet.id)).toHaveLength(1);
    });

    test("BET sem saldo: 1 REJECTED e 49 replays 422, uma única linha, saldo intacto", async () => {
      const wallet = await openWallet(http(0), "100.00");
      const bet = wagerPayload(wallet, { money: money("500.00") });

      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => submit(http(index), bet, keyFor(bet))),
      );

      expect(statuses(responses)).toEqual(Array(50).fill(422));
      expect(
        count(
          responses.map((response) => outcomeOf(response).idempotentReplay),
          false,
        ),
      ).toBe(1);
      expect(new Set(responses.map((response) => outcomeOf(response).transactionId)).size).toBe(1);
      expect(await transactionsOf(client(), wallet.id)).toHaveLength(1);
      expect(await walletSnapshot(client(), wallet.id)).toEqual({ balance: "100.00", version: 1 });
    });

    test("25 apostas diferentes, cada uma enviada 3 vezes ao mesmo tempo: cada uma executa uma só vez", async () => {
      const wallet = await openWallet(http(0), "1000.00");
      const bets = Array.from({ length: 25 }, () =>
        wagerPayload(wallet, { money: money("10.00") }),
      );

      const responses = await Promise.all(
        bets.flatMap((bet, betIndex) =>
          [0, 1, 2].map((copy) => submit(http(betIndex + copy), bet, keyFor(bet))),
        ),
      );

      expect(statuses(responses)).toEqual(Array(75).fill(200));
      expect(
        count(
          responses.map((response) => outcomeOf(response).idempotentReplay),
          false,
        ),
      ).toBe(25);
      expect(await walletSnapshot(client(), wallet.id)).toEqual({ balance: "750.00", version: 26 });
      expect(await transactionsOf(client(), wallet.id)).toHaveLength(25);
    });
  });

  describe("c) a mesma Idempotency-Key em wallets diferentes, em paralelo", () => {
    const wallets = async (total: number) =>
      Promise.all(Array.from({ length: total }, (_, index) => openWallet(http(index), "100.00")));

    const rowsWithKey = async (key: string) =>
      (
        await client().query(
          "select wallet_id from wager_transactions where idempotency_key = $1",
          [key],
        )
      ).rows;

    test("chave igual e (provedor, id externo) diferentes: exatamente um vencedor, os demais 409, nenhum 500", async () => {
      const group = await wallets(10);
      const key = "chave-compartilhada-1";

      const responses = await Promise.all(
        group.map((wallet, index) => submit(http(index), wagerPayload(wallet), key)),
      );

      expect(count(statuses(responses), 200)).toBe(1);
      expect(count(statuses(responses), 409)).toBe(9);
      expect(statuses(responses).filter((status) => status >= 500)).toEqual([]);
      for (const loser of responses.filter((response) => response.status === 409)) {
        expect(loser.body).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: expect.any(String) });
      }

      const stored = await rowsWithKey(key);
      expect(stored).toHaveLength(1);

      const snapshots = [];
      for (const wallet of group) {
        snapshots.push(await walletSnapshot(client(), wallet.id));
      }
      const debited = snapshots.filter((snapshot) => snapshot.balance === "90.00");
      expect(debited).toHaveLength(1);
    });

    test("chave igual E mesmo (provedor, id externo) em wallets diferentes: um vencedor, os demais 409 IDEMPOTENCY_CONFLICT", async () => {
      const group = await wallets(10);
      const key = "chave-compartilhada-2";

      const responses = await Promise.all(
        group.map((wallet, index) =>
          submit(
            http(index),
            wagerPayload(wallet, { externalTransactionId: "id-externo-compartilhado" }),
            key,
          ),
        ),
      );

      expect(count(statuses(responses), 200)).toBe(1);
      expect(count(statuses(responses), 409)).toBe(9);
      expect(statuses(responses).filter((status) => status >= 500)).toEqual([]);
      for (const loser of responses.filter((response) => response.status === 409)) {
        expect(loser.body).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      }
      expect(await rowsWithKey(key)).toHaveLength(1);
    });

    test("chaves diferentes e mesmo (provedor, id externo) em wallets diferentes: um vencedor, os demais 409 EXTERNAL_TRANSACTION_CONFLICT", async () => {
      const group = await wallets(10);

      const responses = await Promise.all(
        group.map((wallet, index) =>
          submit(
            http(index),
            wagerPayload(wallet, { externalTransactionId: "id-externo-disputado" }),
            `chave-distinta-${index}`,
          ),
        ),
      );

      expect(count(statuses(responses), 200)).toBe(1);
      expect(count(statuses(responses), 409)).toBe(9);
      expect(statuses(responses).filter((status) => status >= 500)).toEqual([]);
      for (const loser of responses.filter((response) => response.status === 409)) {
        expect(loser.body).toEqual({
          code: "EXTERNAL_TRANSACTION_CONFLICT",
          message: expect.any(String),
        });
      }

      const { rows } = await client().query(
        "select 1 from wager_transactions where provider_id = 'provider-a' and external_transaction_id = 'id-externo-disputado'",
      );
      expect(rows).toHaveLength(1);
    });

    test("a mesma chave e o mesmo payload, repetidos 5 vezes em cada uma de 4 wallets: um vencedor por wallet e nenhum 500", async () => {
      const group = await wallets(4);
      const payloads = group.map((wallet) => wagerPayload(wallet));

      const responses = await Promise.all(
        payloads.flatMap((payload, walletIndex) =>
          Array.from({ length: 5 }, (_, copy) =>
            submit(http(walletIndex + copy), payload, "chave-unica-global"),
          ),
        ),
      );

      expect(statuses(responses).filter((status) => status >= 500)).toEqual([]);
      expect(count(statuses(responses), 409)).toBe(15);
      expect(count(statuses(responses), 200)).toBe(5);
      expect(await rowsWithKey("chave-unica-global")).toHaveLength(1);
    });
  });

  describe("d) várias wallets diferentes em paralelo, cada uma com várias apostas", () => {
    test("12 wallets × 8 pedidos: saldos, ledger e transações corretos por wallet", async () => {
      const group = await Promise.all(
        Array.from({ length: 12 }, (_, index) => openWallet(http(index), "1000.00")),
      );

      const requests = group.flatMap((wallet) => [
        ...Array.from({ length: 5 }, () =>
          wagerPayload(wallet, { kind: "BET", money: money("10.00") }),
        ),
        ...Array.from({ length: 2 }, () =>
          wagerPayload(wallet, { kind: "WIN", money: money("5.00") }),
        ),
        wagerPayload(wallet, { kind: "LOSS", money: money("3.00") }),
      ]);

      const responses = await Promise.all(
        requests.map((payload, index) => submit(http(index), payload, keyFor(payload))),
      );

      expect(statuses(responses)).toEqual(Array(96).fill(200));
      expect(responses.every((response) => outcomeOf(response).idempotentReplay === false)).toBe(
        true,
      );

      for (const wallet of group) {
        expect(await walletSnapshot(client(), wallet.id)).toEqual({
          balance: "960.00",
          version: 8,
        });
        expect(await ledgerOf(client(), wallet.id)).toHaveLength(8);
        expect(await transactionsOf(client(), wallet.id)).toHaveLength(8);
      }
    });

    test("uma wallet sob disputa pesada (30 apostas de 1.00 sobre 20.00): exatamente 20 PROCESSED, 10 REJECTED, saldo 0.00", async () => {
      const wallet = await openWallet(http(0), "20.00");
      const bets = Array.from({ length: 30 }, () => wagerPayload(wallet, { money: money("1.00") }));

      const responses = await Promise.all(
        bets.map((bet, index) => submit(http(index), bet, keyFor(bet))),
      );

      expect(count(statuses(responses), 200)).toBe(20);
      expect(count(statuses(responses), 422)).toBe(10);
      expect(statuses(responses).filter((status) => status >= 500)).toEqual([]);
      expect(await walletSnapshot(client(), wallet.id)).toEqual({ balance: "0.00", version: 21 });
      expect(
        (await ledgerOf(client(), wallet.id)).filter((entry) => entry.direction === "DEBIT"),
      ).toHaveLength(20);
    });

    test("BETs e WINs misturados na mesma wallet: o saldo final é exatamente o que as respostas PROCESSED somam", async () => {
      const wallet = await openWallet(http(0), "50.00");
      const requests = Array.from({ length: 40 }, (_, index) =>
        wagerPayload(wallet, {
          kind: index % 2 === 0 ? "BET" : "WIN",
          money: money(index % 4 === 0 ? "30.00" : "20.00"),
        }),
      );

      const responses = await Promise.all(
        requests.map((payload, index) => submit(http(index), payload, keyFor(payload))),
      );

      expect(statuses(responses).filter((status) => status >= 500)).toEqual([]);

      let expected = 5000n;
      responses.forEach((response, index) => {
        const request = requests[index];
        const cents = BigInt((request?.money.amount ?? "0.00").replace(".", ""));
        if (outcomeOf(response).status === "PROCESSED") {
          expected += request?.kind === "WIN" ? cents : -cents;
        }
      });

      const snapshot = await walletSnapshot(client(), wallet.id);
      const finalCents = BigInt(snapshot.balance.replace(".", ""));

      expect(finalCents).toBe(expected);
      expect(finalCents >= 0n).toBe(true);
    });

    test("40 wallets diferentes em paralelo: todas processam, uma transação por wallet", async () => {
      const group = await Promise.all(
        Array.from({ length: 40 }, (_, index) => openWallet(http(index), "100.00")),
      );
      const before = await tableCounts(client());

      const responses = await Promise.all(
        group.map((wallet, index) => {
          const payload = wagerPayload(wallet);
          return submit(http(index), payload, keyFor(payload));
        }),
      );

      expect(statuses(responses)).toEqual(Array(40).fill(200));
      const after = await tableCounts(client());
      expect(after.wager_transactions - before.wager_transactions).toBe(40);
    });
  });
});
