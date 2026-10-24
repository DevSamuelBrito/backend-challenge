import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { expectInvariants } from "../support/invariants";
import { tableCounts } from "../support/table-counts";
import {
  eventsOfTransaction,
  keyFor,
  ledgerOf,
  type OpenedWallet,
  openWallet,
  submit,
  submitWithDefaultKey,
  transactionsOf,
  type WagerPayload,
  wagerPayload,
  walletSnapshot,
} from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

const money = (amount: string, currency = "BRL") => ({ amount, currency });

describe("POST /wagering/transactions: BET, WIN e LOSS (HTTP e Postgres reais)", () => {
  let api: WalletApi;

  beforeAll(async () => {
    api = await startWalletApi();
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(async () => {
    await expectInvariants(api.db.client);
  });

  const wallet = (balance = "100.00", currency = "BRL") => openWallet(api.http, balance, currency);

  const send = (target: OpenedWallet, overrides: Partial<WagerPayload> = {}) => {
    const payload = wagerPayload(target, overrides);
    return { payload, response: submitWithDefaultKey(api.http, payload) };
  };

  const call = async (target: OpenedWallet, overrides: Partial<WagerPayload> = {}) => {
    const { payload, response } = send(target, overrides);
    return { payload, result: await response };
  };

  const eventTypes = async (transactionId: string) =>
    (await eventsOfTransaction(api.db.client, transactionId)).map((event) => event.event_type);

  describe("BET", () => {
    test("200 PROCESSED, debita o saldo e grava transação, ledger e eventos", async () => {
      const target = await wallet("100.00");

      const { payload, result } = await call(target, { money: money("25.00") });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        transactionId: expect.any(String),
        status: "PROCESSED",
        balance: money("75.00"),
        idempotentReplay: false,
      });

      const { transactionId } = result.body as { transactionId: string };

      expect(await walletSnapshot(api.db.client, target.id)).toEqual({
        balance: "75.00",
        version: 2,
      });

      const [stored] = await transactionsOf(api.db.client, target.id);
      expect(stored).toMatchObject({
        id: transactionId,
        kind: "BET",
        status: "PROCESSED",
        failure_code: null,
        amount: "25.00",
        currency: "BRL",
        balance_after_amount: "75.00",
        idempotency_key: keyFor(payload),
        provider_id: payload.providerId,
        external_transaction_id: payload.externalTransactionId,
      });
      expect(stored?.payload_hash).toMatch(/^[0-9a-f]{64}$/);

      const ledger = await ledgerOf(api.db.client, target.id);
      expect(ledger.map((entry) => entry.wallet_version)).toEqual([1, 2]);
      expect(ledger[1]).toEqual({
        transaction_id: transactionId,
        direction: "DEBIT",
        amount: "25.00",
        balance_before: "100.00",
        balance_after: "75.00",
        wallet_version: 2,
      });

      expect(await eventTypes(transactionId)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
    });

    test("os eventos carregam a Idempotency-Key como causationId e o mesmo correlationId", async () => {
      const target = await wallet("100.00");

      const { payload, result } = await call(target, { money: money("10.00") });
      const { transactionId } = result.body as { transactionId: string };
      const events = await eventsOfTransaction(api.db.client, transactionId);

      expect(events.map((event) => event.payload.causationId)).toEqual([
        keyFor(payload),
        keyFor(payload),
      ]);
      const correlation = events.map(
        (event) => (event.payload as unknown as { correlationId: string }).correlationId,
      );
      expect(new Set(correlation).size).toBe(1);
      expect(events[0]?.payload.data).toMatchObject({
        status: "PROCESSED",
        kind: "BET",
        money: money("10.00"),
        balanceAfter: money("90.00"),
      });
      expect(events[1]?.payload.data).toMatchObject({
        direction: "DEBIT",
        walletVersion: 2,
        balanceBefore: money("100.00"),
        balanceAfter: money("90.00"),
      });
    });

    test("aposta que zera o saldo é aceita; um centavo a mais é rejeitado", async () => {
      const target = await wallet("100.00");

      const all = await call(target, { money: money("100.00") });
      const more = await call(target, { money: money("0.01") });

      expect(all.result.status).toBe(200);
      expect(all.result.body).toMatchObject({ balance: money("0.00") });
      expect(more.result.status).toBe(422);
      expect(more.result.body).toMatchObject({
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
        balance: money("0.00"),
      });
    });

    test("aposta com o saldo máximo do Money debita sem perder precisão", async () => {
      const target = await wallet("999999999999999999.99");

      const { result } = await call(target, { money: money("999999999999999999.99") });

      expect(result.body).toMatchObject({ status: "PROCESSED", balance: money("0.00") });
    });

    test("sem saldo: 422 REJECTED persistida, sem ledger, saldo intacto e só o evento Rejected", async () => {
      const target = await wallet("100.00");

      const { payload, result } = await call(target, { money: money("150.00") });

      expect(result.status).toBe(422);
      expect(result.body).toEqual({
        transactionId: expect.any(String),
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
        balance: money("100.00"),
        idempotentReplay: false,
      });

      const { transactionId } = result.body as { transactionId: string };
      const [stored] = await transactionsOf(api.db.client, target.id);

      expect(stored).toMatchObject({
        id: transactionId,
        status: "REJECTED",
        failure_code: "INSUFFICIENT_FUNDS",
        amount: "150.00",
        balance_after_amount: "100.00",
        idempotency_key: keyFor(payload),
      });
      expect(await walletSnapshot(api.db.client, target.id)).toEqual({
        balance: "100.00",
        version: 1,
      });
      expect(
        (await ledgerOf(api.db.client, target.id)).map((entry) => entry.wallet_version),
      ).toEqual([1]);
      expect(await eventTypes(transactionId)).toEqual(["WagerTransactionRejected"]);

      const [rejected] = await eventsOfTransaction(api.db.client, transactionId);
      expect(rejected?.payload.data).toMatchObject({
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
        kind: "BET",
        money: money("150.00"),
      });
    });
  });

  describe("WIN", () => {
    test("200 PROCESSED, credita o saldo, e emite Processed e WalletBalanceChanged", async () => {
      const target = await wallet("100.00");

      const { result } = await call(target, { kind: "WIN", money: money("40.50") });

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ status: "PROCESSED", balance: money("140.50") });

      const { transactionId } = result.body as { transactionId: string };
      const ledger = await ledgerOf(api.db.client, target.id);

      expect(ledger[1]).toMatchObject({
        transaction_id: transactionId,
        direction: "CREDIT",
        amount: "40.50",
        balance_before: "100.00",
        balance_after: "140.50",
        wallet_version: 2,
      });
      expect(await walletSnapshot(api.db.client, target.id)).toEqual({
        balance: "140.50",
        version: 2,
      });
      expect(await eventTypes(transactionId)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
    });

    test("WIN em wallet com saldo zero (sem OPENING) começa o ledger na version 2", async () => {
      const target = await wallet("0.00");

      const { result } = await call(target, { kind: "WIN", money: money("10.00") });

      expect(result.body).toMatchObject({ status: "PROCESSED", balance: money("10.00") });
      expect(
        (await ledgerOf(api.db.client, target.id)).map((entry) => entry.wallet_version),
      ).toEqual([2]);
    });

    test("WIN que estouraria o limite do Money: 400 MONEY_OUT_OF_RANGE e nada é gravado", async () => {
      const target = await wallet("999999999999999999.99");
      const before = await tableCounts(api.db.client);

      const { result } = await call(target, { kind: "WIN", money: money("0.01") });

      expect(result.status).toBe(400);
      expect(result.body).toEqual({ code: "MONEY_OUT_OF_RANGE", message: expect.any(String) });
      expect(await tableCounts(api.db.client)).toEqual(before);
    });
  });

  describe("LOSS", () => {
    test("200 PROCESSED sem efeito no saldo, sem ledger e SEM WalletBalanceChanged", async () => {
      const target = await wallet("100.00");

      const { result } = await call(target, { kind: "LOSS", money: money("30.00") });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        transactionId: expect.any(String),
        status: "PROCESSED",
        balance: money("100.00"),
        idempotentReplay: false,
      });

      const { transactionId } = result.body as { transactionId: string };
      const [stored] = await transactionsOf(api.db.client, target.id);

      expect(stored).toMatchObject({
        kind: "LOSS",
        status: "PROCESSED",
        amount: "30.00",
        balance_after_amount: "100.00",
      });
      expect(await walletSnapshot(api.db.client, target.id)).toEqual({
        balance: "100.00",
        version: 1,
      });
      expect(await ledgerOf(api.db.client, target.id)).toHaveLength(1);
      expect(await eventTypes(transactionId)).toEqual(["WagerTransactionProcessed"]);
    });

    test("LOSS não consome saldo: pode ser maior que o saldo e continua PROCESSED", async () => {
      const target = await wallet("5.00");

      const { result } = await call(target, { kind: "LOSS", money: money("500.00") });

      expect(result.body).toMatchObject({ status: "PROCESSED", balance: money("5.00") });
    });
  });

  test("sequência BET, WIN e LOSS na mesma wallet: saldo e versions batem", async () => {
    const target = await wallet("100.00");

    await call(target, { kind: "BET", money: money("30.00") });
    await call(target, { kind: "WIN", money: money("50.00") });
    await call(target, { kind: "LOSS", money: money("20.00") });

    expect(await walletSnapshot(api.db.client, target.id)).toEqual({
      balance: "120.00",
      version: 3,
    });
    expect((await ledgerOf(api.db.client, target.id)).map((entry) => entry.direction)).toEqual([
      "CREDIT",
      "DEBIT",
      "CREDIT",
    ]);
    expect(await transactionsOf(api.db.client, target.id)).toHaveLength(3);
  });

  describe("replay (idempotência)", () => {
    test("o mesmo pedido de novo devolve o mesmo corpo com idempotentReplay=true e nenhum segundo débito", async () => {
      const target = await wallet("100.00");
      const payload = wagerPayload(target, { money: money("25.00") });
      const key = keyFor(payload);

      const first = await submit(api.http, payload, key);
      const eventsBefore = await tableCounts(api.db.client);
      const second = await submit(api.http, payload, key);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual({
        ...(first.body as object),
        idempotentReplay: true,
      });
      expect((first.body as { idempotentReplay: boolean }).idempotentReplay).toBe(false);
      expect(await tableCounts(api.db.client)).toEqual(eventsBefore);
      expect(await walletSnapshot(api.db.client, target.id)).toEqual({
        balance: "75.00",
        version: 2,
      });
      expect(await ledgerOf(api.db.client, target.id)).toHaveLength(2);
    });

    test("replay depois de o saldo mudar devolve o saldo ORIGINAL, nunca o atual", async () => {
      const target = await wallet("100.00");
      const bet = wagerPayload(target, { money: money("30.00") });
      const first = await submit(api.http, bet, keyFor(bet));

      await call(target, { kind: "WIN", money: money("500.00") });
      await call(target, { kind: "BET", money: money("10.00") });
      expect(await walletSnapshot(api.db.client, target.id)).toMatchObject({ balance: "560.00" });

      const replay = await submit(api.http, bet, keyFor(bet));

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({
        ...(first.body as object),
        balance: money("70.00"),
        idempotentReplay: true,
      });
    });

    test("replay de REJECTED devolve 422 com idempotentReplay=true, o mesmo failureCode e o saldo da época", async () => {
      const target = await wallet("100.00");
      const bet = wagerPayload(target, { money: money("500.00") });
      const first = await submit(api.http, bet, keyFor(bet));

      await call(target, { kind: "WIN", money: money("1000.00") });
      const replay = await submit(api.http, bet, keyFor(bet));

      expect(first.status).toBe(422);
      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({
        transactionId: (first.body as { transactionId: string }).transactionId,
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
        balance: money("100.00"),
        idempotentReplay: true,
      });
      expect(await transactionsOf(api.db.client, target.id)).toHaveLength(2);
    });

    test("replay de WIN e de LOSS repete o resultado original", async () => {
      const target = await wallet("100.00");

      for (const kind of ["WIN", "LOSS"]) {
        const payload = wagerPayload(target, { kind, money: money("10.00") });
        const first = await submit(api.http, payload, keyFor(payload));
        const replay = await submit(api.http, payload, keyFor(payload));

        expect(replay.status).toBe(200);
        expect(replay.body).toEqual({ ...(first.body as object), idempotentReplay: true });
      }

      expect(await walletSnapshot(api.db.client, target.id)).toEqual({
        balance: "110.00",
        version: 2,
      });
    });

    test("o replay não precisa repetir o playerId certo da época? Ele é parte do hash: outro playerId vira conflito", async () => {
      const target = await wallet("100.00");
      const payload = wagerPayload(target);
      await submit(api.http, payload, keyFor(payload));

      const other = await submit(
        api.http,
        { ...payload, playerId: "outro-jogador" },
        keyFor(payload),
      );

      expect(other.status).toBe(409);
      expect(other.body).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });

    test("007.50 e 7.50 produzem replay, não conflito (nos dois sentidos)", async () => {
      const target = await wallet("100.00");

      const padded = wagerPayload(target, { money: money("007.50") });
      const plain = { ...padded, money: money("7.50") };
      const first = await submit(api.http, padded, "key-padded-first");
      const replay = await submit(api.http, plain, "key-padded-first");

      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ idempotentReplay: true, balance: money("92.50") });

      const plainFirst = wagerPayload(target, { money: money("7.50") });
      const first2 = await submit(api.http, plainFirst, "key-plain-first");
      const replay2 = await submit(
        api.http,
        { ...plainFirst, money: money("007.50") },
        "key-plain-first",
      );

      expect(first2.status).toBe(200);
      expect(replay2.status).toBe(200);
      expect(replay2.body).toMatchObject({ idempotentReplay: true });
      expect(await ledgerOf(api.db.client, target.id)).toHaveLength(3);
      expect((await transactionsOf(api.db.client, target.id)).map((row) => row.amount)).toEqual([
        "7.50",
        "7.50",
      ]);
    });

    test("a ordem das chaves do JSON enviado não importa para o replay", async () => {
      const target = await wallet("100.00");
      const payload = wagerPayload(target, { money: money("10.00") });
      await submit(api.http, payload, "key-order");

      const reordered = JSON.stringify({
        money: { currency: "BRL", amount: "10.00" },
        kind: "BET",
        gameId: payload.gameId,
        roundId: payload.roundId,
        walletId: payload.walletId,
        playerId: payload.playerId,
        externalTransactionId: payload.externalTransactionId,
        providerId: payload.providerId,
      });
      const replay = await api.http.postRaw(
        "/wagering/transactions",
        reordered,
        "application/json",
        {
          "Idempotency-Key": "key-order",
        },
      );

      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ idempotentReplay: true });
    });

    test("um header com a chave em caixa diferente (idempotency-key) funciona igual", async () => {
      const target = await wallet("100.00");
      const payload = wagerPayload(target);

      const first = await api.http.post("/wagering/transactions", payload, {
        "idempotency-key": "k-lower",
      });
      const second = await api.http.post("/wagering/transactions", payload, {
        "IDEMPOTENCY-KEY": "k-lower",
      });

      expect(first.status).toBe(200);
      expect(second.body).toMatchObject({ idempotentReplay: true });
    });
  });

  describe("conflitos (409, cada um com seu code)", () => {
    test("mesma chave com payload diferente: 409 IDEMPOTENCY_CONFLICT e nada novo é gravado", async () => {
      const target = await wallet("100.00");
      const payload = wagerPayload(target, { money: money("10.00") });
      await submit(api.http, payload, "key-conflict");
      const before = await tableCounts(api.db.client);

      const variations: Partial<WagerPayload>[] = [
        { money: money("10.01") },
        { money: money("10.00", "USD") },
        { kind: "WIN" },
        { roundId: "outra-rodada" },
        { gameId: "outro-jogo" },
        { externalTransactionId: "outro-id-externo" },
        { providerId: "provider-b" },
      ];

      for (const variation of variations) {
        const response = await submit(api.http, { ...payload, ...variation }, "key-conflict");

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
          code: "IDEMPOTENCY_CONFLICT",
          message: expect.any(String),
        });
      }

      expect(await tableCounts(api.db.client)).toEqual(before);
      expect(await walletSnapshot(api.db.client, target.id)).toEqual({
        balance: "90.00",
        version: 2,
      });
    });

    test("a mesma chave em outra wallet com payload diferente é conflito", async () => {
      const first = await wallet("100.00");
      const second = await wallet("100.00");
      const payload = wagerPayload(first);
      await submit(api.http, payload, "key-two-wallets");

      const response = await submit(
        api.http,
        wagerPayload(second, { externalTransactionId: payload.externalTransactionId }),
        "key-two-wallets",
      );

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await walletSnapshot(api.db.client, second.id)).toEqual({
        balance: "100.00",
        version: 1,
      });
    });

    test("mesmo (provider, externalId) com outra chave: 409 EXTERNAL_TRANSACTION_CONFLICT, mesmo com payload idêntico", async () => {
      const target = await wallet("100.00");
      const payload = wagerPayload(target);
      await submit(api.http, payload, "key-original");
      const before = await tableCounts(api.db.client);

      const response = await submit(api.http, payload, "key-outra");

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        code: "EXTERNAL_TRANSACTION_CONFLICT",
        message: expect.any(String),
      });
      expect(await tableCounts(api.db.client)).toEqual(before);
    });

    test("o mesmo externalId em provedores diferentes não conflita", async () => {
      const target = await wallet("100.00");
      const payload = wagerPayload(target);

      const a = await submit(api.http, payload, "key-provider-a");
      const b = await submit(api.http, { ...payload, providerId: "provider-b" }, "key-provider-b");

      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await walletSnapshot(api.db.client, target.id)).toMatchObject({ balance: "80.00" });
    });

    test("reaproveitar a chave de uma OPENING interna é conflito, nunca crédito indevido", async () => {
      const target = await wallet("100.00");

      const response = await submit(
        api.http,
        wagerPayload(target, { kind: "WIN", money: money("999.00") }),
        `opening:${target.id}`,
      );

      expect(response.status).toBe(409);
      expect(await walletSnapshot(api.db.client, target.id)).toEqual({
        balance: "100.00",
        version: 1,
      });
    });

    test("tentar imitar a OPENING (provider internal e externalId = walletId) é conflito", async () => {
      const target = await wallet("100.00");

      const response = await submit(
        api.http,
        wagerPayload(target, {
          providerId: "internal",
          externalTransactionId: target.id,
          kind: "WIN",
          money: money("999.00"),
        }),
        "key-fake-opening",
      );

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "EXTERNAL_TRANSACTION_CONFLICT" });
    });
  });

  describe("regras de negócio (P1, P2, P3)", () => {
    test("wallet inexistente: 404 WALLET_NOT_FOUND e nada é persistido (P1)", async () => {
      const ghost: OpenedWallet = { id: randomUUID(), playerId: "p", currency: "BRL" };
      const before = await tableCounts(api.db.client);

      const { result } = await call(ghost);

      expect(result.status).toBe(404);
      expect(result.body).toEqual({ code: "WALLET_NOT_FOUND", message: expect.any(String) });
      expect(await tableCounts(api.db.client)).toEqual(before);
    });

    test("playerId diferente do dono: 422 WALLET_PLAYER_MISMATCH persistida, sem mexer no saldo (P2)", async () => {
      const target = await wallet("100.00");

      const { result } = await call(target, { playerId: "intruso", money: money("10.00") });

      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        status: "REJECTED",
        failureCode: "WALLET_PLAYER_MISMATCH",
        balance: money("100.00"),
        idempotentReplay: false,
      });

      const { transactionId } = result.body as { transactionId: string };
      const [stored] = await transactionsOf(api.db.client, target.id);

      expect(stored).toMatchObject({
        status: "REJECTED",
        failure_code: "WALLET_PLAYER_MISMATCH",
        balance_after_amount: "100.00",
      });
      expect(await walletSnapshot(api.db.client, target.id)).toEqual({
        balance: "100.00",
        version: 1,
      });
      expect(await ledgerOf(api.db.client, target.id)).toHaveLength(1);
      expect(await eventTypes(transactionId)).toEqual(["WagerTransactionRejected"]);
    });

    test("WIN de outro jogador também é rejeitado e não credita (P2)", async () => {
      const target = await wallet("100.00");

      const { result } = await call(target, {
        playerId: "intruso",
        kind: "WIN",
        money: money("1000.00"),
      });

      expect(result.body).toMatchObject({
        status: "REJECTED",
        failureCode: "WALLET_PLAYER_MISMATCH",
      });
      expect(await walletSnapshot(api.db.client, target.id)).toMatchObject({ balance: "100.00" });
    });

    test("LOSS de outro jogador também é rejeitada, nunca PROCESSED (P2)", async () => {
      const target = await wallet("100.00");

      const { result } = await call(target, { playerId: "intruso", kind: "LOSS" });

      expect(result.body).toMatchObject({
        status: "REJECTED",
        failureCode: "WALLET_PLAYER_MISMATCH",
      });
    });

    test("moeda diferente da wallet: 422 CURRENCY_MISMATCH, saldo gravado e devolvido na moeda da WALLET (P3)", async () => {
      const target = await wallet("100.00", "BRL");

      const { payload, result } = await call(target, { money: money("30.00", "USD") });

      expect(result.status).toBe(422);
      expect(result.body).toEqual({
        transactionId: expect.any(String),
        status: "REJECTED",
        failureCode: "CURRENCY_MISMATCH",
        balance: money("100.00", "BRL"),
        idempotentReplay: false,
      });

      const [stored] = await transactionsOf(api.db.client, target.id);
      expect(stored).toMatchObject({
        status: "REJECTED",
        failure_code: "CURRENCY_MISMATCH",
        amount: "30.00",
        currency: "USD",
        balance_after_amount: "100.00",
      });
      expect(await walletSnapshot(api.db.client, target.id)).toEqual({
        balance: "100.00",
        version: 1,
      });

      const replay = await submit(api.http, payload, keyFor(payload));
      expect(replay.status).toBe(422);
      expect(replay.body).toMatchObject({
        failureCode: "CURRENCY_MISMATCH",
        balance: money("100.00", "BRL"),
        idempotentReplay: true,
      });
    });

    test("a mesma wallet em USD aceita apostas em USD, e rejeita BRL", async () => {
      const target = await wallet("50.00", "USD");

      const accepted = await call(target, { money: money("20.00", "USD") });
      const rejected = await call(target, { money: money("20.00", "BRL") });

      expect(accepted.result.body).toMatchObject({
        status: "PROCESSED",
        balance: money("30.00", "USD"),
      });
      expect(rejected.result.body).toMatchObject({
        failureCode: "CURRENCY_MISMATCH",
        balance: money("30.00", "USD"),
      });
    });

    test("quando playerId e moeda estão errados, vale o playerId (P2 antes de P3)", async () => {
      const target = await wallet("100.00", "BRL");

      const { result } = await call(target, { playerId: "intruso", money: money("1.00", "USD") });

      expect(result.body).toMatchObject({ failureCode: "WALLET_PLAYER_MISMATCH" });
    });
  });

  describe("payload inválido: 400 e nada é persistido", () => {
    const invalid = async (
      overrides: Record<string, unknown>,
      key: string | null = "key-invalid",
    ) => {
      const target = await wallet("100.00");
      const before = await tableCounts(api.db.client);
      const payload = { ...wagerPayload(target), ...overrides };

      const response = await submit(api.http, payload, key ?? undefined);

      expect(await tableCounts(api.db.client)).toEqual(before);
      return response;
    };

    const badMoney: [string, unknown, string][] = [
      ["valor zero", money("0.00"), "INVALID_MONEY"],
      ["valor negativo", money("-10.00"), "INVALID_MONEY"],
      ["1 casa decimal", money("10.0"), "INVALID_MONEY"],
      ["sem casas decimais", money("10"), "INVALID_MONEY"],
      ["3 casas decimais", money("10.005"), "INVALID_MONEY"],
      ["notação científica", money("1e2"), "INVALID_MONEY"],
      ["amount numérico", { amount: 10, currency: "BRL" }, "INVALID_MONEY"],
      ["acima do limite", money("1000000000000000000.00"), "MONEY_OUT_OF_RANGE"],
      ["moeda em minúsculas", money("10.00", "brl"), "INVALID_MONEY"],
      ["moeda com 4 letras", money("10.00", "BRLL"), "INVALID_MONEY"],
      ["moeda ausente", { amount: "10.00" }, "INVALID_MONEY"],
      ["money ausente", undefined, "INVALID_REQUEST"],
      ["money como string", "10.00", "INVALID_REQUEST"],
    ];

    for (const [name, value, code] of badMoney) {
      test(`${name}: 400 ${code}`, async () => {
        const response = await invalid({ money: value });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code, message: expect.any(String) });
      });
    }

    test("header Idempotency-Key ausente: 400 (P10)", async () => {
      const response = await invalid({}, null);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("Idempotency-Key"),
      });
    });

    test("header Idempotency-Key vazio ou só com espaços: 400 (P10)", async () => {
      for (const key of ["", "   "]) {
        const response = await invalid({}, key);

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ code: "INVALID_REQUEST" });
      }
    });

    test("kind OPENING é recusado com 400, e nunca cria transação interna", async () => {
      const response = await invalid({ kind: "OPENING" });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("OPENING"),
      });
    });

    for (const [name, overrides] of [
      ["kind desconhecido", { kind: "DEPOSIT" }],
      ["kind em minúsculas", { kind: "bet" }],
      ["kind ausente", { kind: undefined }],
      ["providerId vazio", { providerId: "" }],
      ["providerId ausente", { providerId: undefined }],
      ["externalTransactionId em branco", { externalTransactionId: "  " }],
      ["playerId ausente", { playerId: undefined }],
      ["roundId ausente", { roundId: undefined }],
      ["gameId ausente", { gameId: undefined }],
      ["walletId que não é UUID", { walletId: "abc" }],
      ["walletId ausente", { walletId: undefined }],
      ["BET com referência", { kind: "BET", referenceExternalTransactionId: "bet-1" }],
      ["REFUND sem referência", { kind: "REFUND" }],
      ["ROLLBACK sem referência", { kind: "ROLLBACK" }],
    ] as [string, Record<string, unknown>][]) {
      test(`${name}: 400 INVALID_REQUEST`, async () => {
        const response = await invalid(overrides);

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code: "INVALID_REQUEST", message: expect.any(String) });
      });
    }

    test("corpo que não é JSON válido ou não é objeto: 400 no formato padrão", async () => {
      for (const raw of ["{", "[]", "null", "42"]) {
        const response = await api.http.postRaw("/wagering/transactions", raw, "application/json", {
          "Idempotency-Key": "k",
        });

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code: "INVALID_REQUEST", message: expect.any(String) });
      }
    });

    test("um payload inválido para uma wallet inexistente é 400, não 404", async () => {
      const ghost: OpenedWallet = { id: randomUUID(), playerId: "p", currency: "BRL" };

      const response = await submit(
        api.http,
        wagerPayload(ghost, { money: money("0.00") }),
        "k-ghost",
      );

      expect(response.status).toBe(400);
    });
  });
});
