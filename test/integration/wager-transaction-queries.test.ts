import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { expectInvariants } from "../support/invariants";
import {
  type OpenedWallet,
  openWallet,
  submitWithDefaultKey,
  type WagerPayload,
  wagerPayload,
} from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

const money = (amount: string, currency = "BRL") => ({ amount, currency });

describe("consultas de transação: por id e por (provider, externalTransactionId)", () => {
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

  const submit = async (wallet: OpenedWallet, overrides: Partial<WagerPayload>) => {
    const payload = wagerPayload(wallet, overrides);
    const result = await submitWithDefaultKey(api.http, payload);

    return {
      payload,
      status: result.status,
      id: (result.body as { transactionId: string }).transactionId,
    };
  };

  const byId = (id: string) => api.http.get(`/wagering/transactions/${id}`);
  const byProvider = (providerId: string, externalId: string) =>
    api.http.get(
      `/providers/${encodeURIComponent(providerId)}/wagering/transactions/${encodeURIComponent(externalId)}`,
    );

  const both = async (created: { id: string; payload: WagerPayload }) => {
    const viaId = await byId(created.id);
    const viaProvider = await byProvider(
      created.payload.providerId,
      created.payload.externalTransactionId,
    );

    expect(viaId.status).toBe(200);
    expect(viaProvider.status).toBe(200);
    expect(viaProvider.body).toEqual(viaId.body);

    return viaId.body as Record<string, unknown>;
  };

  test("PROCESSED: todos os campos, saldo gravado e processedAt, sem failureCode nem referência", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const created = await submit(wallet, { money: money("30.00") });

    const body = await both(created);

    expect(body).toEqual({
      transactionId: created.id,
      providerId: created.payload.providerId,
      externalTransactionId: created.payload.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: money("30.00"),
      status: "PROCESSED",
      balance: money("70.00"),
      createdAt: body.createdAt,
      processedAt: body.processedAt,
    });
    expect(new Date(body.createdAt as string).toISOString()).toBe(body.createdAt as string);
    expect(new Date(body.processedAt as string).toISOString()).toBe(body.processedAt as string);
  });

  test("REJECTED é 200 e traz o failureCode e o saldo gravado", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const created = await submit(wallet, { money: money("500.00") });
    expect(created.status).toBe(422);

    const body = await both(created);

    expect(body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: money("100.00"),
      kind: "BET",
    });
    expect(body.processedAt).toBeDefined();
  });

  test("LOSS: PROCESSED sem lançamento, com o saldo da época", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const created = await submit(wallet, { kind: "LOSS", money: money("40.00") });

    const body = await both(created);

    expect(body).toMatchObject({ kind: "LOSS", status: "PROCESSED", balance: money("100.00") });
    expect(body).not.toHaveProperty("failureCode");
  });

  test("PENDING_REFERENCE: sem saldo, sem processedAt e com a referência esperada", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const created = await submit(wallet, {
      kind: "ROLLBACK",
      money: money("10.00"),
      referenceExternalTransactionId: "ainda-nao-chegou",
    });
    expect(created.status).toBe(202);

    const body = await both(created);

    expect(body).toMatchObject({
      kind: "ROLLBACK",
      status: "PENDING_REFERENCE",
      referenceExternalTransactionId: "ainda-nao-chegou",
    });
    expect(body).not.toHaveProperty("balance");
    expect(body).not.toHaveProperty("failureCode");
    expect(body).not.toHaveProperty("processedAt");
  });

  test("WIN com referência traz referenceExternalTransactionId", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const bet = await submit(wallet, { money: money("20.00") });
    const win = await submit(wallet, {
      kind: "WIN",
      money: money("50.00"),
      referenceExternalTransactionId: bet.payload.externalTransactionId,
    });

    const body = await both(win);

    expect(body).toMatchObject({
      kind: "WIN",
      status: "PROCESSED",
      referenceExternalTransactionId: bet.payload.externalTransactionId,
      balance: money("130.00"),
    });
  });

  test("OPENING: provedor interno, externalTransactionId = walletId", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const { rows } = await api.db.client.query(
      "select id from wager_transactions where wallet_id = $1 and kind = 'OPENING'",
      [wallet.id],
    );
    const openingId = rows[0].id as string;

    const viaId = await byId(openingId);
    const viaProvider = await byProvider("internal", wallet.id);

    expect(viaId.status).toBe(200);
    expect(viaProvider.body).toEqual(viaId.body);
    expect(viaId.body).toMatchObject({
      transactionId: openingId,
      providerId: "internal",
      externalTransactionId: wallet.id,
      kind: "OPENING",
      status: "PROCESSED",
      money: money("100.00"),
      balance: money("100.00"),
      roundId: "opening",
      gameId: "opening",
    });
  });

  test("é uma leitura: consultar não altera nada no banco", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const created = await submit(wallet, { money: money("30.00") });
    const before = await api.db.client.query(
      "select (select count(*) from wager_transactions) t, (select count(*) from outbox_messages) o, (select count(*) from wallet_ledger_entries) l, (select balance::text from wallets where id = $1) b",
      [wallet.id],
    );

    await both(created);

    const after = await api.db.client.query(
      "select (select count(*) from wager_transactions) t, (select count(*) from outbox_messages) o, (select count(*) from wallet_ledger_entries) l, (select balance::text from wallets where id = $1) b",
      [wallet.id],
    );
    expect(after.rows).toEqual(before.rows);
  });

  test("404: transação inexistente por id e por (provider, externalId)", async () => {
    const missingId = await byId(randomUUID());
    const missingExternal = await byProvider("provider-a", "nao-existe");

    expect(missingId.status).toBe(404);
    expect(missingId.body).toMatchObject({ code: "TRANSACTION_NOT_FOUND" });
    expect(missingExternal.status).toBe(404);
    expect(missingExternal.body).toMatchObject({ code: "TRANSACTION_NOT_FOUND" });
  });

  test("o provedor faz parte da chave: o mesmo externalId em outro provedor é 404", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const created = await submit(wallet, { money: money("10.00") });

    const other = await byProvider("outro-provedor", created.payload.externalTransactionId);

    expect(other.status).toBe(404);
  });

  test.each([["123"], ["nao-e-uuid"], ["0192f298-345e-7e38-af88-e43f851a819"], ["{}"]])(
    "transactionId malformado (%s) é 400",
    async (value) => {
      const result = await byId(value);

      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ code: "INVALID_REQUEST" });
    },
  );

  test("providerId ou externalTransactionId com mais de 255 caracteres é 400", async () => {
    const tooLong = "x".repeat(256);

    expect((await byProvider(tooLong, "ext")).status).toBe(400);
    expect((await byProvider("provider-a", tooLong)).status).toBe(400);
  });
});

describe("valores acima de Number.MAX_SAFE_INTEGER passam intactos pelas respostas", () => {
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

  test("transação, ledger e wallet devolvem as strings exatas", async () => {
    const wallet = await openWallet(api.http, "9007199254740993.00");
    const payload = wagerPayload(wallet, { money: money("1.01") });
    const result = await submitWithDefaultKey(api.http, payload);
    expect(result.status).toBe(200);
    const { transactionId } = result.body as { transactionId: string };

    const transaction = (await api.http.get(`/wagering/transactions/${transactionId}`))
      .body as Record<string, unknown>;
    const ledger = (await api.http.get(`/wallets/${wallet.id}/ledger`)).body as {
      items: Record<string, { amount: string }>[];
    };

    expect(transaction.balance).toEqual(money("9007199254740991.99"));
    expect(transaction.money).toEqual(money("1.01"));
    expect(ledger.items[0]?.money).toEqual(money("9007199254740993.00"));
    expect(ledger.items[0]?.balanceAfter).toEqual(money("9007199254740993.00"));
    expect(ledger.items[1]?.balanceBefore).toEqual(money("9007199254740993.00"));
    expect(ledger.items[1]?.balanceAfter).toEqual(money("9007199254740991.99"));
  });
});
