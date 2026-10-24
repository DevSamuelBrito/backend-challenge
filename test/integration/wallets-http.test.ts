import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { expectInvariants } from "../support/invariants";
import { tableCounts } from "../support/table-counts";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const request = (playerId: string, amount = "100.00", currency = "BRL") => ({
  playerId,
  initialBalance: { amount, currency },
});

const newPlayer = () => `player-${randomUUID()}`;

describe("POST /wallets e GET /wallets/:walletId (HTTP e Postgres reais)", () => {
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

  const rows = async (sql: string, params: unknown[]) =>
    (await api.db.client.query(sql, params)).rows as Record<string, unknown>[];

  describe("saldo inicial positivo", () => {
    test("201 com { id, playerId, balance, version } e tudo gravado de forma atômica", async () => {
      const playerId = newPlayer();

      const response = await api.http.post("/wallets", request(playerId, "100.00"));

      expect(response.status).toBe(201);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.body).toEqual({
        id: expect.stringMatching(UUID_V7),
        playerId,
        balance: { amount: "100.00", currency: "BRL" },
        version: 1,
      });

      const { id } = response.body as { id: string };

      const wallets = await rows("select * from wallets where id = $1", [id]);
      expect(wallets).toHaveLength(1);
      expect(wallets[0]).toMatchObject({
        player_id: playerId,
        currency: "BRL",
        balance: "100.00",
        version: 1,
      });

      const transactions = await rows("select * from wager_transactions where wallet_id = $1", [
        id,
      ]);
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({
        provider_id: "internal",
        external_transaction_id: id,
        idempotency_key: `opening:${id}`,
        wallet_id: id,
        player_id: playerId,
        round_id: "opening",
        game_id: "opening",
        kind: "OPENING",
        amount: "100.00",
        currency: "BRL",
        status: "PROCESSED",
        balance_after_amount: "100.00",
        failure_code: null,
        reference_transaction_id: null,
        reference_external_transaction_id: null,
      });
      expect(transactions[0]?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(transactions[0]?.processed_at).toBeInstanceOf(Date);

      const ledger = await rows("select * from wallet_ledger_entries where wallet_id = $1", [id]);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        wallet_id: id,
        transaction_id: transactions[0]?.id,
        direction: "CREDIT",
        amount: "100.00",
        currency: "BRL",
        balance_before: "0.00",
        balance_after: "100.00",
        wallet_version: 1,
      });
    });

    test("a outbox recebe exatamente dois eventos, na ordem: WagerTransactionProcessed e WalletBalanceChanged", async () => {
      const response = await api.http.post("/wallets", request(newPlayer(), "42.50", "USD"));
      const { id } = response.body as { id: string };
      const [transaction] = await rows("select id from wager_transactions where wallet_id = $1", [
        id,
      ]);

      const events = await rows(
        `select * from outbox_messages
          where aggregate_id in ($1, $2)
          order by seq`,
        [id, transaction?.id],
      );

      expect(events.map((event) => event.event_type)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
      expect(events.map((event) => event.aggregate_id)).toEqual([transaction?.id, id]);
      expect(events.every((event) => event.published_at === null)).toBe(true);
      expect(events.every((event) => event.attempts === 0)).toBe(true);

      const [processed, balanceChanged] = events.map(
        (event) => event.payload as Record<string, unknown> & { data: Record<string, unknown> },
      );

      expect(processed).toMatchObject({
        eventType: "WagerTransactionProcessed",
        version: 1,
        aggregateId: transaction?.id,
        causationId: `opening:${id}`,
        data: {
          transactionId: transaction?.id,
          walletId: id,
          providerId: "internal",
          kind: "OPENING",
          status: "PROCESSED",
          money: { amount: "42.50", currency: "USD" },
          balanceAfter: { amount: "42.50", currency: "USD" },
        },
      });
      expect(balanceChanged).toMatchObject({
        eventType: "WalletBalanceChanged",
        version: 1,
        aggregateId: id,
        causationId: `opening:${id}`,
        data: {
          walletId: id,
          transactionId: transaction?.id,
          direction: "CREDIT",
          money: { amount: "42.50", currency: "USD" },
          balanceBefore: { amount: "0.00", currency: "USD" },
          balanceAfter: { amount: "42.50", currency: "USD" },
          walletVersion: 1,
        },
      });
      expect(processed?.correlationId).toBe(balanceChanged?.correlationId as string);
      expect(events.map((event) => event.id)).toEqual(
        [processed, balanceChanged].map((payload) => payload?.eventId),
      );
    });

    test("aceita o valor máximo exato do Money", async () => {
      const response = await api.http.post(
        "/wallets",
        request(newPlayer(), "999999999999999999.99"),
      );

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        balance: { amount: "999999999999999999.99", currency: "BRL" },
      });
    });
  });

  describe("saldo inicial zero", () => {
    test("201 com version 1, sem OPENING, sem ledger e sem eventos", async () => {
      const playerId = newPlayer();

      const response = await api.http.post("/wallets", request(playerId, "0.00"));

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        id: expect.stringMatching(UUID_V7),
        playerId,
        balance: { amount: "0.00", currency: "BRL" },
        version: 1,
      });

      const { id } = response.body as { id: string };

      expect(await rows("select 1 from wallets where id = $1", [id])).toHaveLength(1);
      expect(await rows("select 1 from wager_transactions where wallet_id = $1", [id])).toEqual([]);
      expect(await rows("select 1 from wallet_ledger_entries where wallet_id = $1", [id])).toEqual(
        [],
      );
      expect(await rows("select 1 from outbox_messages where aggregate_id = $1", [id])).toEqual([]);
    });
  });

  describe("unicidade por jogador e moeda", () => {
    test("repetir jogador e moeda dá 409 com code estável e não grava nada além da primeira", async () => {
      const playerId = newPlayer();
      const first = await api.http.post("/wallets", request(playerId, "100.00"));
      const before = await tableCounts(api.db.client);

      const second = await api.http.post("/wallets", request(playerId, "999.00"));

      expect(first.status).toBe(201);
      expect(second.status).toBe(409);
      expect(second.body).toEqual({
        code: "WALLET_ALREADY_EXISTS",
        message: expect.stringContaining(playerId),
      });
      expect(await tableCounts(api.db.client)).toEqual(before);

      const stored = await rows("select balance, version from wallets where player_id = $1", [
        playerId,
      ]);
      expect(stored).toEqual([{ balance: "100.00", version: 1 }]);
    });

    test("duplicata com saldo zero também dá 409", async () => {
      const playerId = newPlayer();

      await api.http.post("/wallets", request(playerId, "0.00"));
      const second = await api.http.post("/wallets", request(playerId, "50.00"));

      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: "WALLET_ALREADY_EXISTS" });
    });

    test("o mesmo jogador pode ter uma wallet por moeda", async () => {
      const playerId = newPlayer();

      const brl = await api.http.post("/wallets", request(playerId, "100.00", "BRL"));
      const usd = await api.http.post("/wallets", request(playerId, "10.00", "USD"));
      const eur = await api.http.post("/wallets", request(playerId, "0.00", "EUR"));

      expect([brl.status, usd.status, eur.status]).toEqual([201, 201, 201]);

      const ids = [brl, usd, eur].map((response) => (response.body as { id: string }).id);
      expect(new Set(ids).size).toBe(3);

      const stored = await rows(
        "select currency, balance from wallets where player_id = $1 order by currency",
        [playerId],
      );
      expect(stored).toEqual([
        { currency: "BRL", balance: "100.00" },
        { currency: "EUR", balance: "0.00" },
        { currency: "USD", balance: "10.00" },
      ]);
    });

    test("jogadores diferentes na mesma moeda não conflitam", async () => {
      const first = await api.http.post("/wallets", request(newPlayer()));
      const second = await api.http.post("/wallets", request(newPlayer()));

      expect([first.status, second.status]).toEqual([201, 201]);
    });

    test("20 criações simultâneas do mesmo jogador e moeda: exatamente um 201 e 19 vezes 409, nenhum 500", async () => {
      const playerId = newPlayer();

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => api.http.post("/wallets", request(playerId, "100.00"))),
      );

      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(19);
      expect(statuses.filter((status) => status >= 500)).toEqual([]);

      for (const loser of responses.filter((response) => response.status === 409)) {
        expect(loser.body).toEqual({
          code: "WALLET_ALREADY_EXISTS",
          message: expect.any(String),
        });
      }

      const winner = responses.find((response) => response.status === 201);
      const { id } = (winner as { body: { id: string } }).body;

      expect(await rows("select id from wallets where player_id = $1", [playerId])).toEqual([
        { id },
      ]);
      expect(
        await rows("select 1 from wager_transactions where wallet_id = $1", [id]),
      ).toHaveLength(1);
      expect(
        await rows("select 1 from wallet_ledger_entries where wallet_id = $1", [id]),
      ).toHaveLength(1);
      expect(
        await rows(
          `select 1 from outbox_messages
            where aggregate_id = $1
               or aggregate_id = (select id from wager_transactions where wallet_id = $1)`,
          [id],
        ),
      ).toHaveLength(2);
    });

    test("20 criações simultâneas com saldo zero: um 201 e 19 vezes 409", async () => {
      const playerId = newPlayer();

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => api.http.post("/wallets", request(playerId, "0.00"))),
      );

      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(19);
      expect(await rows("select 1 from wallets where player_id = $1", [playerId])).toHaveLength(1);
    });

    test("criações simultâneas de jogadores e moedas diferentes funcionam todas", async () => {
      const playerId = newPlayer();
      const currencies = ["BRL", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF"];

      const responses = await Promise.all([
        ...currencies.map((currency) =>
          api.http.post("/wallets", request(playerId, "5.00", currency)),
        ),
        ...Array.from({ length: 12 }, () => api.http.post("/wallets", request(newPlayer()))),
      ]);

      expect(responses.map((response) => response.status)).toEqual(Array(20).fill(201));
    });
  });

  describe("payload inválido", () => {
    const invalidBodies: [string, unknown, string][] = [
      ["amount negativo", request("p", "-10.00"), "INVALID_MONEY"],
      ["amount com 1 casa decimal", request("p", "10.0"), "INVALID_MONEY"],
      ["amount sem casas decimais", request("p", "10"), "INVALID_MONEY"],
      ["amount com 3 casas decimais", request("p", "10.005"), "INVALID_MONEY"],
      ["amount em notação científica", request("p", "1e3"), "INVALID_MONEY"],
      ["amount vazio", request("p", ""), "INVALID_MONEY"],
      [
        "amount como número JSON",
        { playerId: "p", initialBalance: { amount: 100, currency: "BRL" } },
        "INVALID_MONEY",
      ],
      ["amount ausente", { playerId: "p", initialBalance: { currency: "BRL" } }, "INVALID_MONEY"],
      ["amount acima do limite", request("p", "1000000000000000000.00"), "MONEY_OUT_OF_RANGE"],
      ["moeda em minúsculas", request("p", "10.00", "brl"), "INVALID_MONEY"],
      ["moeda com 2 letras", request("p", "10.00", "BR"), "INVALID_MONEY"],
      ["moeda com 4 letras", request("p", "10.00", "BRLL"), "INVALID_MONEY"],
      ["moeda vazia", request("p", "10.00", ""), "INVALID_MONEY"],
      ["moeda ausente", { playerId: "p", initialBalance: { amount: "10.00" } }, "INVALID_MONEY"],
      ["playerId vazio", request("", "10.00"), "INVALID_REQUEST"],
      ["playerId só com espaços", request("   ", "10.00"), "INVALID_REQUEST"],
      [
        "playerId ausente",
        { initialBalance: { amount: "10.00", currency: "BRL" } },
        "INVALID_REQUEST",
      ],
      [
        "playerId numérico",
        { playerId: 7, initialBalance: { amount: "10.00", currency: "BRL" } },
        "INVALID_REQUEST",
      ],
      ["corpo sem initialBalance", { playerId: "p" }, "INVALID_REQUEST"],
      ["initialBalance nulo", { playerId: "p", initialBalance: null }, "INVALID_REQUEST"],
      [
        "initialBalance como string",
        { playerId: "p", initialBalance: "100.00" },
        "INVALID_REQUEST",
      ],
      ["corpo vazio", {}, "INVALID_REQUEST"],
      ["corpo que é um array", [request("p")], "INVALID_REQUEST"],
    ];

    for (const [name, body, code] of invalidBodies) {
      test(`${name}: 400 ${code} e nada é gravado`, async () => {
        const before = await tableCounts(api.db.client);

        const response = await api.http.post("/wallets", body);

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code, message: expect.any(String) });
        expect(await tableCounts(api.db.client)).toEqual(before);
      });
    }

    const rawBodies: [string, string, string | undefined][] = [
      ["JSON malformado", '{"playerId": "p", "initialBalance": ', undefined],
      ["corpo vazio com content-type JSON", "", undefined],
      ["JSON que é um número", "42", undefined],
      ["JSON null", "null", undefined],
      ["content-type que não é JSON", JSON.stringify(request("p")), "text/plain"],
    ];

    for (const [name, raw, contentType] of rawBodies) {
      test(`${name}: 400 no formato padrão e nada é gravado`, async () => {
        const before = await tableCounts(api.db.client);

        const response = await api.http.postRaw("/wallets", raw, contentType);

        expect(response.status).toBe(400);
        expect(response.body).toEqual({ code: "INVALID_REQUEST", message: expect.any(String) });
        expect(await tableCounts(api.db.client)).toEqual(before);
      });
    }

    test("um corpo grande demais é recusado com o formato padrão", async () => {
      const before = await tableCounts(api.db.client);
      const huge = JSON.stringify({ ...request("p"), padding: "x".repeat(200_000) });

      const response = await api.http.postRaw("/wallets", huge);

      expect(response.status).toBe(413);
      expect(response.body).toEqual({ code: "PAYLOAD_TOO_LARGE", message: expect.any(String) });
      expect(await tableCounts(api.db.client)).toEqual(before);
    });
  });

  describe("GET /wallets/:walletId", () => {
    test("200 com a wallet criada", async () => {
      const playerId = newPlayer();
      const created = await api.http.post("/wallets", request(playerId, "75.25", "USD"));
      const { id } = created.body as { id: string };

      const response = await api.http.get(`/wallets/${id}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id,
        playerId,
        balance: { amount: "75.25", currency: "USD" },
        version: 1,
      });
    });

    test("200 também para wallet criada com saldo zero", async () => {
      const created = await api.http.post("/wallets", request(newPlayer(), "0.00"));
      const { id } = created.body as { id: string };

      const response = await api.http.get(`/wallets/${id}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id, balance: { amount: "0.00", currency: "BRL" } });
    });

    test("devolve o saldo máximo sem perder precisão", async () => {
      const created = await api.http.post(
        "/wallets",
        request(newPlayer(), "999999999999999999.99"),
      );
      const { id } = created.body as { id: string };

      const response = await api.http.get(`/wallets/${id}`);

      expect(response.body).toMatchObject({
        balance: { amount: "999999999999999999.99", currency: "BRL" },
      });
    });

    test("404 com code estável para uma wallet que não existe", async () => {
      const unknown = randomUUID();

      const response = await api.http.get(`/wallets/${unknown}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        code: "WALLET_NOT_FOUND",
        message: expect.stringContaining(unknown),
      });
    });

    test("400 para um id que não é UUID, sem chegar ao banco", async () => {
      for (const id of ["abc", "123", "nao-e-um-uuid", "123e4567e89b12d3a456426614174000"]) {
        const response = await api.http.get(`/wallets/${id}`);

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("walletId"),
        });
      }
    });

    test("rota inexistente responde 404 no formato padrão", async () => {
      const response = await api.http.get("/nao-existe");

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ code: "NOT_FOUND", message: expect.any(String) });
    });

    test("um método não suportado na rota de wallets responde no formato padrão", async () => {
      const response = await fetch(`${api.url}/wallets`, { method: "DELETE" });

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
