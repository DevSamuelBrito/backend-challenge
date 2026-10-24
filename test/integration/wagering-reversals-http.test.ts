import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { expectInvariants } from "../support/invariants";
import { insertRow, transactionRow } from "../support/schema-fixtures";
import { tableCounts } from "../support/table-counts";
import {
  eventsOfTransaction,
  ledgerOf,
  type OpenedWallet,
  openWallet,
  submitWithDefaultKey,
  transactionsOf,
  type WagerPayload,
  wagerPayload,
  walletSnapshot,
} from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

const money = (amount: string, currency = "BRL") => ({ amount, currency });

interface Placed {
  payload: WagerPayload;
  status: number;
  body: {
    transactionId: string;
    status: string;
    failureCode?: string;
    balance: { amount: string; currency: string };
    idempotentReplay: boolean;
  };
}

describe("POST /wagering/transactions: REFUND, ROLLBACK e referências (HTTP e Postgres reais)", () => {
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

  const client = () => api.db.client;
  const wallet = (balance = "100.00", currency = "BRL") => openWallet(api.http, balance, currency);

  const place = async (
    target: OpenedWallet,
    overrides: Partial<WagerPayload> = {},
  ): Promise<Placed> => {
    const payload = wagerPayload(target, overrides);
    const result = await submitWithDefaultKey(api.http, payload);

    return { payload, status: result.status, body: result.body as Placed["body"] };
  };

  const processed = async (target: OpenedWallet, overrides: Partial<WagerPayload> = {}) => {
    const placed = await place(target, overrides);
    expect(placed.status).toBe(200);
    expect(placed.body.status).toBe("PROCESSED");

    return placed;
  };

  const bet = (target: OpenedWallet, amount = "25.00", overrides: Partial<WagerPayload> = {}) =>
    processed(target, { kind: "BET", money: money(amount), ...overrides });

  const win = (target: OpenedWallet, amount: string, overrides: Partial<WagerPayload> = {}) =>
    processed(target, { kind: "WIN", money: money(amount), ...overrides });

  const reverse = (
    target: OpenedWallet,
    kind: "REFUND" | "ROLLBACK",
    original: Placed,
    overrides: Partial<WagerPayload> = {},
  ) =>
    place(target, {
      kind,
      referenceExternalTransactionId: original.payload.externalTransactionId,
      money: original.payload.money,
      roundId: original.payload.roundId,
      ...overrides,
    });

  const eventTypes = async (transactionId: string) =>
    (await eventsOfTransaction(client(), transactionId)).map((event) => event.event_type);

  const movements = async (target: OpenedWallet) =>
    (await ledgerOf(client(), target.id)).slice(1).map((entry) => ({
      direction: entry.direction,
      amount: entry.amount,
      balanceAfter: entry.balance_after,
    }));

  const balanceOf = async (target: OpenedWallet) =>
    (await walletSnapshot(client(), target.id)).balance;

  const rowOf = async (transactionId: string) => {
    const { rows } = await client().query(
      `select status, failure_code, reference_transaction_id, reference_attempts,
              balance_after_amount::text as balance_after_amount,
              extract(epoch from (next_attempt_at - created_at))::float as retry_delay_seconds,
              next_attempt_at
         from wager_transactions where id = $1`,
      [transactionId],
    );

    return rows[0] as {
      status: string;
      failure_code: string | null;
      reference_transaction_id: string | null;
      reference_attempts: number;
      balance_after_amount: string | null;
      retry_delay_seconds: number | null;
      next_attempt_at: Date | null;
    };
  };

  const expectRejected = (placed: Placed, failureCode: string, balance: string) => {
    expect(placed.status).toBe(422);
    expect(placed.body).toEqual({
      transactionId: expect.any(String),
      status: "REJECTED",
      failureCode,
      balance: money(balance),
      idempotentReplay: false,
    });
  };

  describe("REFUND", () => {
    test("de uma BET: devolve o saldo, grava 1 lançamento CREDIT e emite os eventos certos", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");

      const refund = await reverse(target, "REFUND", original);

      expect(refund.status).toBe(200);
      expect(refund.body).toEqual({
        transactionId: expect.any(String),
        status: "PROCESSED",
        balance: money("100.00"),
        idempotentReplay: false,
      });

      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "100.00", version: 3 });
      expect(await movements(target)).toEqual([
        { direction: "DEBIT", amount: "25.00", balanceAfter: "75.00" },
        { direction: "CREDIT", amount: "25.00", balanceAfter: "100.00" },
      ]);

      const ledger = await ledgerOf(client(), target.id);
      expect(ledger[2]?.transaction_id).toBe(refund.body.transactionId);

      expect(await rowOf(refund.body.transactionId)).toMatchObject({
        status: "PROCESSED",
        failure_code: null,
        reference_transaction_id: original.body.transactionId,
        balance_after_amount: "100.00",
        reference_attempts: 0,
        next_attempt_at: null,
      });
      expect(await eventTypes(refund.body.transactionId)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
    });

    test("de uma BET REJECTED: REJECTED REFERENCE_NOT_PROCESSED, sem lançamento e sem mexer no saldo", async () => {
      const target = await wallet("20.00");
      const rejectedBet = await place(target, { kind: "BET", money: money("80.00") });
      expectRejected(rejectedBet, "INSUFFICIENT_FUNDS", "20.00");

      const refund = await reverse(target, "REFUND", rejectedBet);

      expectRejected(refund, "REFERENCE_NOT_PROCESSED", "20.00");
      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "20.00", version: 1 });
      expect(await movements(target)).toEqual([]);
      expect(await eventTypes(refund.body.transactionId)).toEqual(["WagerTransactionRejected"]);
    });

    test("a rejeição é persistida e auditável (REJECTED + failureCode + balance_after)", async () => {
      const target = await wallet("20.00");
      const rejectedBet = await place(target, { kind: "BET", money: money("80.00") });
      const refund = await reverse(target, "REFUND", rejectedBet);

      expect(await rowOf(refund.body.transactionId)).toMatchObject({
        status: "REJECTED",
        failure_code: "REFERENCE_NOT_PROCESSED",
        reference_transaction_id: null,
        balance_after_amount: "20.00",
      });
    });

    test.each([
      ["WIN", "REFUND de WIN"],
      ["LOSS", "REFUND de LOSS"],
    ])("de %s: REFERENCE_KIND_NOT_ALLOWED (%s)", async (kind) => {
      const target = await wallet("100.00");
      const original = await processed(target, { kind, money: money("10.00") });

      const refund = await reverse(target, "REFUND", original);

      expectRejected(refund, "REFERENCE_KIND_NOT_ALLOWED", await balanceOf(target));
      expect(await eventTypes(refund.body.transactionId)).toEqual(["WagerTransactionRejected"]);
    });

    test("de um REFUND: REFERENCE_KIND_NOT_ALLOWED", async () => {
      const target = await wallet("100.00");
      const original = await bet(target);
      const refund = await reverse(target, "REFUND", original);

      const again = await reverse(target, "REFUND", refund, {
        money: refund.payload.money,
      });

      expectRejected(again, "REFERENCE_KIND_NOT_ALLOWED", "100.00");
    });
  });

  describe("ROLLBACK: o lançamento é o INVERSO da referência", () => {
    test("de BET => CREDIT: o débito da aposta é desfeito", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "40.00");

      const rollback = await reverse(target, "ROLLBACK", original);

      expect(rollback.status).toBe(200);
      expect(rollback.body.balance).toEqual(money("100.00"));
      expect(await movements(target)).toEqual([
        { direction: "DEBIT", amount: "40.00", balanceAfter: "60.00" },
        { direction: "CREDIT", amount: "40.00", balanceAfter: "100.00" },
      ]);
      expect(await eventTypes(rollback.body.transactionId)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
    });

    test("de WIN => DEBIT: o prêmio é retirado", async () => {
      const target = await wallet("100.00");
      const prize = await win(target, "50.00");

      const rollback = await reverse(target, "ROLLBACK", prize);

      expect(rollback.status).toBe(200);
      expect(rollback.body.balance).toEqual(money("100.00"));
      expect(await movements(target)).toEqual([
        { direction: "CREDIT", amount: "50.00", balanceAfter: "150.00" },
        { direction: "DEBIT", amount: "50.00", balanceAfter: "100.00" },
      ]);
    });

    test("de WIN que referenciava uma BET => DEBIT, guardando a WIN como referência", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "10.00");
      const prize = await win(target, "30.00", {
        referenceExternalTransactionId: original.payload.externalTransactionId,
      });

      const rollback = await reverse(target, "ROLLBACK", prize);

      expect(rollback.status).toBe(200);
      expect(await balanceOf(target)).toBe("90.00");
      expect((await rowOf(rollback.body.transactionId)).reference_transaction_id).toBe(
        prize.body.transactionId,
      );
    });

    test("de REFUND => DEBIT: o reembolso é retirado", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      const refund = await reverse(target, "REFUND", original);
      expect(refund.status).toBe(200);

      const rollback = await reverse(target, "ROLLBACK", refund);

      expect(rollback.status).toBe(200);
      expect(rollback.body.balance).toEqual(money("75.00"));
      expect(await movements(target)).toEqual([
        { direction: "DEBIT", amount: "25.00", balanceAfter: "75.00" },
        { direction: "CREDIT", amount: "25.00", balanceAfter: "100.00" },
        { direction: "DEBIT", amount: "25.00", balanceAfter: "75.00" },
      ]);
    });

    test("de WIN com o saldo já gasto: REJECTED REVERSAL_INSUFFICIENT_FUNDS, saldo intacto e sem lançamento", async () => {
      const target = await wallet("100.00");
      const prize = await win(target, "50.00");
      await bet(target, "140.00");
      const before = await tableCounts(client());
      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "10.00", version: 3 });

      const rollback = await reverse(target, "ROLLBACK", prize);

      expectRejected(rollback, "REVERSAL_INSUFFICIENT_FUNDS", "10.00");
      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "10.00", version: 3 });
      expect(await movements(target)).toHaveLength(2);

      const after = await tableCounts(client());
      expect(after.wallet_ledger_entries).toBe(before.wallet_ledger_entries);
      expect(after.wager_transactions).toBe(before.wager_transactions + 1);
      expect(await eventTypes(rollback.body.transactionId)).toEqual(["WagerTransactionRejected"]);
      expect(await rowOf(rollback.body.transactionId)).toMatchObject({
        status: "REJECTED",
        failure_code: "REVERSAL_INSUFFICIENT_FUNDS",
        balance_after_amount: "10.00",
      });
    });

    test("a rejeição por saldo não consome a reversão única: com saldo suficiente, um novo ROLLBACK passa", async () => {
      const target = await wallet("100.00");
      const prize = await win(target, "50.00");
      await bet(target, "140.00");
      const rejected = await reverse(target, "ROLLBACK", prize);
      expectRejected(rejected, "REVERSAL_INSUFFICIENT_FUNDS", "10.00");

      await win(target, "100.00");
      const retry = await reverse(target, "ROLLBACK", prize);

      expect(retry.status).toBe(200);
      expect(retry.body.balance).toEqual(money("60.00"));
      expect(await balanceOf(target)).toBe("60.00");
    });

    test("de WIN com saldo exatamente igual ao valor: passa e zera a wallet", async () => {
      const target = await wallet("0.00");
      const prize = await win(target, "50.00");

      const rollback = await reverse(target, "ROLLBACK", prize);

      expect(rollback.status).toBe(200);
      expect(rollback.body.balance).toEqual(money("0.00"));
    });

    test("de LOSS: REFERENCE_KIND_NOT_ALLOWED", async () => {
      const target = await wallet("100.00");
      const loss = await processed(target, { kind: "LOSS", money: money("10.00") });

      const rollback = await reverse(target, "ROLLBACK", loss);

      expectRejected(rollback, "REFERENCE_KIND_NOT_ALLOWED", "100.00");
    });

    test("de ROLLBACK: REFERENCE_KIND_NOT_ALLOWED", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      const first = await reverse(target, "ROLLBACK", original);
      expect(first.status).toBe(200);

      const second = await reverse(target, "ROLLBACK", first);

      expectRejected(second, "REFERENCE_KIND_NOT_ALLOWED", "100.00");
    });

    test("de OPENING: REFERENCE_KIND_NOT_ALLOWED", async () => {
      const target = await wallet("100.00");

      const rollback = await place(target, {
        kind: "ROLLBACK",
        providerId: "internal",
        referenceExternalTransactionId: target.id,
        roundId: "opening",
        gameId: "opening",
        money: money("100.00"),
      });

      expectRejected(rollback, "REFERENCE_KIND_NOT_ALLOWED", "100.00");
      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "100.00", version: 1 });
    });
  });

  describe("divergências entre a reversão e a referência (D7): um failureCode por caso", () => {
    test.each([["REFUND"], ["ROLLBACK"]] as const)(
      "%s com rodada diferente: REFERENCE_ROUND_MISMATCH",
      async (kind) => {
        const target = await wallet("100.00");
        const original = await bet(target, "25.00");

        const reversal = await reverse(target, kind, original, { roundId: "round-2" });

        expectRejected(reversal, "REFERENCE_ROUND_MISMATCH", "75.00");
        expect(await balanceOf(target)).toBe("75.00");
      },
    );

    test.each([["REFUND"], ["ROLLBACK"]] as const)(
      "%s a partir de outra wallet: REFERENCE_WALLET_MISMATCH, e a wallet da referência não é tocada",
      async (kind) => {
        const owner = await wallet("100.00");
        const other = await wallet("100.00");
        const original = await bet(owner, "25.00");

        const reversal = await reverse(other, kind, original);

        expectRejected(reversal, "REFERENCE_WALLET_MISMATCH", "100.00");
        expect(await walletSnapshot(client(), owner.id)).toEqual({ balance: "75.00", version: 2 });
        expect(await walletSnapshot(client(), other.id)).toEqual({ balance: "100.00", version: 1 });
      },
    );

    test.each([["REFUND"], ["ROLLBACK"]] as const)(
      "%s cuja referência é de outro player: REFERENCE_PLAYER_MISMATCH",
      async (kind) => {
        const target = await wallet("100.00");
        const intruder = await place(target, {
          kind: "BET",
          playerId: "outro-player",
          money: money("25.00"),
        });
        expectRejected(intruder, "WALLET_PLAYER_MISMATCH", "100.00");

        const reversal = await reverse(target, kind, intruder);

        expectRejected(reversal, "REFERENCE_PLAYER_MISMATCH", "100.00");
      },
    );

    test.each([["REFUND"], ["ROLLBACK"]] as const)(
      "%s cuja referência é de outra moeda: REFERENCE_CURRENCY_MISMATCH",
      async (kind) => {
        const target = await wallet("100.00");
        const foreign = await place(target, { kind: "BET", money: money("25.00", "USD") });
        expectRejected(foreign, "CURRENCY_MISMATCH", "100.00");

        const reversal = await reverse(target, kind, foreign, { money: money("25.00") });

        expectRejected(reversal, "REFERENCE_CURRENCY_MISMATCH", "100.00");
      },
    );

    test.each([
      ["REFUND", "24.99"],
      ["REFUND", "25.01"],
      ["ROLLBACK", "24.99"],
      ["ROLLBACK", "50.00"],
    ] as const)(
      "%s de %s sobre uma referência de 25.00: REFERENCE_AMOUNT_MISMATCH (sem reversão parcial)",
      async (kind, amount) => {
        const target = await wallet("100.00");
        const original = await bet(target, "25.00");

        const reversal = await reverse(target, kind, original, { money: money(amount) });

        expectRejected(reversal, "REFERENCE_AMOUNT_MISMATCH", "75.00");
        expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "75.00", version: 2 });
        expect(await eventTypes(reversal.body.transactionId)).toEqual(["WagerTransactionRejected"]);
      },
    );

    test("a divergência rejeitada não consome a reversão única: a reversão correta ainda passa", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      const wrong = await reverse(target, "REFUND", original, { money: money("24.00") });
      expectRejected(wrong, "REFERENCE_AMOUNT_MISMATCH", "75.00");

      const right = await reverse(target, "REFUND", original);

      expect(right.status).toBe(200);
      expect(await balanceOf(target)).toBe("100.00");
    });

    test("moeda da reversão diferente da wallet: CURRENCY_MISMATCH vem antes de olhar a referência (P3)", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");

      const reversal = await reverse(target, "REFUND", original, { money: money("25.00", "USD") });

      expectRejected(reversal, "CURRENCY_MISMATCH", "75.00");
    });

    test("player da reversão diferente do dono da wallet: WALLET_PLAYER_MISMATCH vem antes da referência (P2)", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");

      const reversal = await reverse(target, "REFUND", original, { playerId: "outro-player" });

      expectRejected(reversal, "WALLET_PLAYER_MISMATCH", "75.00");
    });

    test("wallet inexistente: 404 e nada é persistido", async () => {
      const ghost: OpenedWallet = { id: randomUUID(), playerId: "p", currency: "BRL" };
      const before = await tableCounts(client());

      const reversal = await place(ghost, {
        kind: "REFUND",
        referenceExternalTransactionId: "bet-1",
        money: money("25.00"),
      });

      expect(reversal.status).toBe(404);
      expect(await tableCounts(client())).toEqual(before);
    });
  });

  describe("reversão única (D4): cada transação só pode ser revertida UMA vez, por qualquer tipo", () => {
    test("REFUND depois de ROLLBACK da mesma BET: o REFUND é REFERENCE_ALREADY_REVERSED", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      expect((await reverse(target, "ROLLBACK", original)).status).toBe(200);

      const refund = await reverse(target, "REFUND", original);

      expectRejected(refund, "REFERENCE_ALREADY_REVERSED", "100.00");
      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "100.00", version: 3 });
    });

    test("ROLLBACK depois de REFUND da mesma BET: o ROLLBACK é REFERENCE_ALREADY_REVERSED", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      expect((await reverse(target, "REFUND", original)).status).toBe(200);

      const rollback = await reverse(target, "ROLLBACK", original);

      expectRejected(rollback, "REFERENCE_ALREADY_REVERSED", "100.00");
      expect(await movements(target)).toHaveLength(2);
    });

    test("dois REFUNDs da mesma BET: o segundo é REFERENCE_ALREADY_REVERSED e só há um crédito", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      expect((await reverse(target, "REFUND", original)).status).toBe(200);

      const second = await reverse(target, "REFUND", original);

      expectRejected(second, "REFERENCE_ALREADY_REVERSED", "100.00");
      const credits = (await movements(target)).filter((entry) => entry.direction === "CREDIT");
      expect(credits).toHaveLength(1);
      expect(await eventTypes(second.body.transactionId)).toEqual(["WagerTransactionRejected"]);
    });

    test("dois ROLLBACKs do mesmo WIN: o segundo é REFERENCE_ALREADY_REVERSED e só há um débito", async () => {
      const target = await wallet("100.00");
      const prize = await win(target, "50.00");
      expect((await reverse(target, "ROLLBACK", prize)).status).toBe(200);

      const second = await reverse(target, "ROLLBACK", prize);

      expectRejected(second, "REFERENCE_ALREADY_REVERSED", "100.00");
      expect(await balanceOf(target)).toBe("100.00");
    });

    test("ROLLBACK duas vezes do mesmo REFUND: o segundo é REFERENCE_ALREADY_REVERSED", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      const refund = await reverse(target, "REFUND", original);
      expect((await reverse(target, "ROLLBACK", refund)).status).toBe(200);

      const second = await reverse(target, "ROLLBACK", refund);

      expectRejected(second, "REFERENCE_ALREADY_REVERSED", "75.00");
    });

    test("a reversão rejeitada não conta como reversão: o REFUND seguinte ainda é aceito se a primeira falhou", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      const wrongRound = await reverse(target, "ROLLBACK", original, { roundId: "round-2" });
      expectRejected(wrongRound, "REFERENCE_ROUND_MISMATCH", "75.00");

      const refund = await reverse(target, "REFUND", original);

      expect(refund.status).toBe(200);
      expect(await balanceOf(target)).toBe("100.00");
    });

    test("reversões de BETs diferentes não se atrapalham", async () => {
      const target = await wallet("100.00");
      const first = await bet(target, "10.00");
      const second = await bet(target, "20.00");

      expect((await reverse(target, "REFUND", first)).status).toBe(200);
      expect((await reverse(target, "REFUND", second)).status).toBe(200);
      expect(await balanceOf(target)).toBe("100.00");
    });

    test("uma WIN que referencia a BET não conta como reversão dela: o REFUND seguinte passa", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      await win(target, "10.00", {
        referenceExternalTransactionId: original.payload.externalTransactionId,
      });

      const refund = await reverse(target, "REFUND", original);

      expect(refund.status).toBe(200);
      expect(await balanceOf(target)).toBe("110.00");
    });

    test.each([
      ["REJECTED", { failure_code: "REFERENCE_NOT_PROCESSED" }],
      ["PENDING_REFERENCE", { next_attempt_at: new Date() }],
    ])(
      "só reversão PROCESSED conta: uma reversão %s apontando para a BET não impede o REFUND",
      async (status, extra) => {
        const target = await wallet("100.00");
        const original = await bet(target, "25.00");
        await insertRow(
          client(),
          "wager_transactions",
          transactionRow(target.id, {
            player_id: target.playerId,
            kind: "REFUND",
            status,
            reference_external_transaction_id: original.payload.externalTransactionId,
            reference_transaction_id: original.body.transactionId,
            ...extra,
          }),
        );

        const refund = await reverse(target, "REFUND", original);

        expect(refund.status).toBe(200);
        expect(await balanceOf(target)).toBe("100.00");
      },
    );
  });

  describe("referência ausente: PENDING_REFERENCE (202)", () => {
    const pendingOverrides = (kind: string): Partial<WagerPayload> => ({
      kind,
      referenceExternalTransactionId: `ainda-nao-chegou-${randomUUID()}`,
      money: money("25.00"),
    });

    test.each([["REFUND"], ["ROLLBACK"], ["WIN"], ["LOSS"]])(
      "%s com referência inexistente: 202, persistida, saldo e ledger intactos, 1 evento PendingReference",
      async (kind) => {
        const target = await wallet("100.00");
        const before = await tableCounts(client());

        const pending = await place(target, pendingOverrides(kind));

        expect(pending.status).toBe(202);
        expect(pending.body).toEqual({
          transactionId: expect.any(String),
          status: "PENDING_REFERENCE",
          balance: money("100.00"),
          idempotentReplay: false,
        });
        expect(pending.body).not.toHaveProperty("failureCode");

        expect(await walletSnapshot(client(), target.id)).toEqual({
          balance: "100.00",
          version: 1,
        });
        const after = await tableCounts(client());
        expect(after.wallet_ledger_entries).toBe(before.wallet_ledger_entries);
        expect(after.wager_transactions).toBe(before.wager_transactions + 1);
        expect(after.outbox_messages).toBe(before.outbox_messages + 1);

        expect(await eventTypes(pending.body.transactionId)).toEqual([
          "WagerTransactionPendingReference",
        ]);
      },
    );

    test("grava reference_attempts = 0 e next_attempt_at = agora + 1s, sem resultado", async () => {
      const target = await wallet("100.00");

      const pending = await place(target, pendingOverrides("REFUND"));
      const row = await rowOf(pending.body.transactionId);

      expect(row).toMatchObject({
        status: "PENDING_REFERENCE",
        failure_code: null,
        reference_transaction_id: null,
        balance_after_amount: null,
        reference_attempts: 0,
      });
      expect(row.retry_delay_seconds).toBe(1);
    });

    test("o evento PendingReference carrega a referência esperada e a Idempotency-Key como causationId", async () => {
      const target = await wallet("100.00");
      const overrides = pendingOverrides("ROLLBACK");

      const pending = await place(target, overrides);
      const [event] = await eventsOfTransaction(client(), pending.body.transactionId);

      expect(event?.payload.causationId).toBe(
        `${pending.payload.providerId}:${pending.payload.externalTransactionId}`,
      );
      expect(event?.payload.data).toMatchObject({
        status: "PENDING_REFERENCE",
        kind: "ROLLBACK",
        referenceExternalTransactionId: overrides.referenceExternalTransactionId,
      });
    });

    test("replay devolve 202 de novo, com idempotentReplay=true, e NÃO emite outro evento", async () => {
      const target = await wallet("100.00");
      const pending = await place(target, pendingOverrides("REFUND"));
      const before = await tableCounts(client());

      for (let attempt = 0; attempt < 3; attempt++) {
        const replay = await submitWithDefaultKey(api.http, pending.payload);

        expect(replay.status).toBe(202);
        expect(replay.body).toEqual({
          transactionId: pending.body.transactionId,
          status: "PENDING_REFERENCE",
          balance: money("100.00"),
          idempotentReplay: true,
        });
      }

      expect(await tableCounts(client())).toEqual(before);
      expect(await eventTypes(pending.body.transactionId)).toEqual([
        "WagerTransactionPendingReference",
      ]);
    });

    test("enquanto a referência não existe, o replay não muda o estado nem a linha", async () => {
      const target = await wallet("100.00");
      const pending = await place(target, pendingOverrides("REFUND"));
      const rowBefore = await rowOf(pending.body.transactionId);

      await submitWithDefaultKey(api.http, pending.payload);
      await submitWithDefaultKey(api.http, pending.payload);

      expect(await rowOf(pending.body.transactionId)).toEqual(rowBefore);
    });

    test("o replay mostra o saldo ATUAL da wallet (a transação ainda não tem resultado)", async () => {
      const target = await wallet("100.00");
      const pending = await place(target, pendingOverrides("REFUND"));
      await bet(target, "10.00");

      const replay = await submitWithDefaultKey(api.http, pending.payload);

      expect(replay.status).toBe(202);
      expect((replay.body as Placed["body"]).balance).toEqual(money("90.00"));
    });

    test("P7: se a transação já foi resolvida como REJECTED, o replay devolve o resultado final (422)", async () => {
      const target = await wallet("100.00");
      const pending = await place(target, pendingOverrides("REFUND"));
      await client().query(
        `update wager_transactions
            set status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND',
                balance_after_amount = 100.00, processed_at = now(), next_attempt_at = null
          where id = $1`,
        [pending.body.transactionId],
      );

      const replay = await submitWithDefaultKey(api.http, pending.payload);

      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({
        transactionId: pending.body.transactionId,
        status: "REJECTED",
        failureCode: "REFERENCE_NOT_FOUND",
        balance: money("100.00"),
        idempotentReplay: true,
      });
    });

    test("P7: se já foi resolvida como PROCESSED, o replay devolve o resultado final (200)", async () => {
      const target = await wallet("100.00");
      const pending = await place(target, pendingOverrides("LOSS"));
      await client().query(
        `update wager_transactions
            set status = 'PROCESSED', balance_after_amount = 100.00, processed_at = now(),
                next_attempt_at = null
          where id = $1`,
        [pending.body.transactionId],
      );

      const replay = await submitWithDefaultKey(api.http, pending.payload);

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({
        transactionId: pending.body.transactionId,
        status: "PROCESSED",
        balance: money("100.00"),
        idempotentReplay: true,
      });
    });

    test("a referência é resolvida por (providerId, referência): outro provedor com o mesmo id não serve", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00", { providerId: "provider-b" });

      const refund = await reverse(target, "REFUND", original, { providerId: "provider-a" });

      expect(refund.status).toBe(202);
      expect(refund.body.status).toBe("PENDING_REFERENCE");
      expect(await balanceOf(target)).toBe("75.00");
    });

    test("o mesmo provedor resolve a referência normalmente", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00", { providerId: "provider-b" });

      const refund = await reverse(target, "REFUND", original, { providerId: "provider-b" });

      expect(refund.status).toBe(200);
    });
  });

  describe("referência existente mas ainda não decidida (cenário montado direto no banco)", () => {
    const seededBet = async (target: OpenedWallet, status: string) => {
      const row = transactionRow(target.id, {
        player_id: target.playerId,
        status,
        external_transaction_id: `seed-${randomUUID()}`,
        ...(status === "PENDING_REFERENCE" && { next_attempt_at: new Date() }),
      });
      await insertRow(client(), "wager_transactions", row);

      return row.external_transaction_id as string;
    };

    for (const status of ["PENDING", "PENDING_REFERENCE"]) {
      test.each([["REFUND"], ["ROLLBACK"], ["WIN"], ["LOSS"]])(
        `%s cuja referência está ${status} continua PENDING_REFERENCE (P5)`,
        async (kind) => {
          const target = await wallet("100.00");
          const referenceId = await seededBet(target, status);

          const result = await place(target, {
            kind,
            referenceExternalTransactionId: referenceId,
            money: money("25.00"),
          });

          expect(result.status).toBe(202);
          expect(result.body.status).toBe("PENDING_REFERENCE");
          expect(result.body.balance).toEqual(money("100.00"));
          expect(await walletSnapshot(client(), target.id)).toEqual({
            balance: "100.00",
            version: 1,
          });
          expect(await eventTypes(result.body.transactionId)).toEqual([
            "WagerTransactionPendingReference",
          ]);
        },
      );
    }

    test("referência FAILED => REJECTED REFERENCE_NOT_PROCESSED", async () => {
      const target = await wallet("100.00");
      const referenceId = await seededBet(target, "FAILED");

      const result = await place(target, {
        kind: "REFUND",
        referenceExternalTransactionId: referenceId,
        money: money("25.00"),
      });

      expectRejected(result, "REFERENCE_NOT_PROCESSED", "100.00");
    });

    test("referência divergente ainda PENDING é rejeitada na hora (o contexto não muda)", async () => {
      const target = await wallet("100.00");
      const referenceId = await seededBet(target, "PENDING");

      const result = await place(target, {
        kind: "REFUND",
        referenceExternalTransactionId: referenceId,
        money: money("25.00"),
        roundId: "round-2",
      });

      expectRejected(result, "REFERENCE_ROUND_MISMATCH", "100.00");
    });
  });

  describe("WIN e LOSS com referência opcional (P4)", () => {
    test("WIN com referência a uma BET válida: PROCESSED, credita e guarda a BET como referência", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "10.00");

      const prize = await win(target, "30.00", {
        referenceExternalTransactionId: original.payload.externalTransactionId,
      });

      expect(prize.body.balance).toEqual(money("120.00"));
      expect((await rowOf(prize.body.transactionId)).reference_transaction_id).toBe(
        original.body.transactionId,
      );
      expect(await movements(target)).toEqual([
        { direction: "DEBIT", amount: "10.00", balanceAfter: "90.00" },
        { direction: "CREDIT", amount: "30.00", balanceAfter: "120.00" },
      ]);
      expect(await eventTypes(prize.body.transactionId)).toEqual([
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
    });

    test("LOSS com referência a uma BET válida: PROCESSED, sem lançamento, guardando a BET", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "10.00");

      const loss = await processed(target, {
        kind: "LOSS",
        money: money("10.00"),
        referenceExternalTransactionId: original.payload.externalTransactionId,
      });

      expect(loss.body.balance).toEqual(money("90.00"));
      expect(await movements(target)).toHaveLength(1);
      expect((await rowOf(loss.body.transactionId)).reference_transaction_id).toBe(
        original.body.transactionId,
      );
      expect(await eventTypes(loss.body.transactionId)).toEqual(["WagerTransactionProcessed"]);
    });

    test("WIN e LOSS NÃO comparam valor com a BET referenciada", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "10.00");
      const reference = original.payload.externalTransactionId;

      const prize = await win(target, "250.00", { referenceExternalTransactionId: reference });
      const loss = await processed(target, {
        kind: "LOSS",
        money: money("999.00"),
        referenceExternalTransactionId: reference,
      });

      expect(prize.body.balance).toEqual(money("340.00"));
      expect(loss.body.balance).toEqual(money("340.00"));
    });

    test("WIN com referência a uma BET inexistente: 202 PENDING_REFERENCE, sem mexer no saldo", async () => {
      const target = await wallet("100.00");

      const pending = await place(target, {
        kind: "WIN",
        money: money("30.00"),
        referenceExternalTransactionId: "bet-que-nao-chegou",
      });

      expect(pending.status).toBe(202);
      expect(pending.body.status).toBe("PENDING_REFERENCE");
      expect(await walletSnapshot(client(), target.id)).toEqual({ balance: "100.00", version: 1 });
    });

    test("WIN referenciando uma BET REJECTED: REFERENCE_NOT_PROCESSED", async () => {
      const target = await wallet("20.00");
      const rejectedBet = await place(target, { kind: "BET", money: money("80.00") });

      const prize = await place(target, {
        kind: "WIN",
        money: money("10.00"),
        referenceExternalTransactionId: rejectedBet.payload.externalTransactionId,
      });

      expectRejected(prize, "REFERENCE_NOT_PROCESSED", "20.00");
    });

    test.each([
      ["WIN", "WIN"],
      ["WIN", "LOSS"],
      ["LOSS", "WIN"],
    ])("%s referenciando %s: REFERENCE_KIND_NOT_ALLOWED", async (kind, referencedKind) => {
      const target = await wallet("100.00");
      const original = await processed(target, { kind: referencedKind, money: money("10.00") });

      const result = await place(target, {
        kind,
        money: money("10.00"),
        referenceExternalTransactionId: original.payload.externalTransactionId,
      });

      expectRejected(result, "REFERENCE_KIND_NOT_ALLOWED", await balanceOf(target));
    });

    test("WIN referenciando uma BET de outra rodada: REFERENCE_ROUND_MISMATCH", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "10.00");

      const prize = await place(target, {
        kind: "WIN",
        money: money("10.00"),
        roundId: "round-2",
        referenceExternalTransactionId: original.payload.externalTransactionId,
      });

      expectRejected(prize, "REFERENCE_ROUND_MISMATCH", "90.00");
    });

    test("WIN referenciando uma BET já reembolsada ainda é aceita (a reversão única só vale para reversões)", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "10.00");
      await reverse(target, "REFUND", original);

      const prize = await win(target, "5.00", {
        referenceExternalTransactionId: original.payload.externalTransactionId,
      });

      expect(prize.body.balance).toEqual(money("105.00"));
    });

    test("WIN sem referência continua como na etapa 8", async () => {
      const target = await wallet("100.00");

      const prize = await win(target, "30.00");

      expect(prize.body.balance).toEqual(money("130.00"));
      expect((await rowOf(prize.body.transactionId)).reference_transaction_id).toBeNull();
    });
  });

  describe("idempotência das reversões", () => {
    test("replay de REFUND PROCESSED devolve o resultado original, mesmo depois de outros movimentos", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      const refund = await reverse(target, "REFUND", original);
      await bet(target, "40.00");
      const before = await tableCounts(client());

      const replay = await submitWithDefaultKey(api.http, refund.payload);

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({
        transactionId: refund.body.transactionId,
        status: "PROCESSED",
        balance: money("100.00"),
        idempotentReplay: true,
      });
      expect(await tableCounts(client())).toEqual(before);
    });

    test("replay de reversão REJECTED devolve o mesmo 422 e failureCode, sem novo evento", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      await reverse(target, "REFUND", original);
      const second = await reverse(target, "REFUND", original);
      expectRejected(second, "REFERENCE_ALREADY_REVERSED", "100.00");
      const before = await tableCounts(client());

      const replay = await submitWithDefaultKey(api.http, second.payload);

      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({
        transactionId: second.body.transactionId,
        status: "REJECTED",
        failureCode: "REFERENCE_ALREADY_REVERSED",
        balance: money("100.00"),
        idempotentReplay: true,
      });
      expect(await tableCounts(client())).toEqual(before);
    });

    test("a referência faz parte do payloadHash: mesma chave com outra referência é 409 IDEMPOTENCY_CONFLICT", async () => {
      const target = await wallet("100.00");
      const original = await bet(target, "25.00");
      const refund = await reverse(target, "REFUND", original);

      const conflicting = await submitWithDefaultKey(api.http, {
        ...refund.payload,
        referenceExternalTransactionId: "outra-bet",
      });

      expect(conflicting.status).toBe(409);
      expect((conflicting.body as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");
    });

    test("um ROLLBACK rejeitado por saldo, reenviado, devolve o mesmo resultado em vez de tentar de novo", async () => {
      const target = await wallet("100.00");
      const prize = await win(target, "50.00");
      await bet(target, "140.00");
      const rejected = await reverse(target, "ROLLBACK", prize);
      await win(target, "100.00");

      const replay = await submitWithDefaultKey(api.http, rejected.payload);

      expect(replay.status).toBe(422);
      expect((replay.body as Placed["body"]).failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
      expect((replay.body as Placed["body"]).idempotentReplay).toBe(true);
      expect(await balanceOf(target)).toBe("110.00");
    });
  });

  describe("a reversão não atrapalha o resto do ledger", () => {
    test("BET, WIN, REFUND e ROLLBACK em sequência: saldo e ledger fecham", async () => {
      const target = await wallet("100.00");
      const first = await bet(target, "30.00");
      const prize = await win(target, "70.00");
      await reverse(target, "REFUND", first);
      await reverse(target, "ROLLBACK", prize);

      expect(await balanceOf(target)).toBe("100.00");
      expect(await movements(target)).toEqual([
        { direction: "DEBIT", amount: "30.00", balanceAfter: "70.00" },
        { direction: "CREDIT", amount: "70.00", balanceAfter: "140.00" },
        { direction: "CREDIT", amount: "30.00", balanceAfter: "170.00" },
        { direction: "DEBIT", amount: "70.00", balanceAfter: "100.00" },
      ]);
      const stored = await transactionsOf(client(), target.id);
      expect(stored.map((row) => row.status)).toEqual([
        "PROCESSED",
        "PROCESSED",
        "PROCESSED",
        "PROCESSED",
      ]);
    });
  });
});
