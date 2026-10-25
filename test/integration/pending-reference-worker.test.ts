import { describe, expect, test } from "bun:test";
import type { Client } from "pg";
import type { PendingReferenceCandidate } from "../../src/modules/wagering/application/wager-transaction.repository";
import { waitUntilSomeoneWaitsOnLock } from "../support/async";
import { money, T0, useScenario } from "../support/pending-scenario";
import { tableCounts } from "../support/table-counts";
import {
  eventsOfTransaction,
  ledgerOf,
  type OpenedWallet,
  openWallet,
} from "../support/wagering-api";

const SECOND = 1000;
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

describe("worker de PENDING_REFERENCE: a referência chega depois", () => {
  const s = useScenario();

  test("REFUND pendente + BET que chega depois => PROCESSED, saldo, ledger e eventos corretos, sem novo PendingReference", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
    const refund = await s.pendingReversal(
      target,
      "REFUND",
      original.externalTransactionId,
      "25.00",
    );
    expect((await s.send(original)).status).toBe(200);
    expect(await s.balanceOf(target)).toBe("75.00");

    const report = await s.tickAfter(SECOND);

    expect(report).toMatchObject({ candidates: 1, processed: 1, failed: 0 });
    expect(await s.row(refund.body.transactionId)).toMatchObject({
      status: "PROCESSED",
      failure_code: null,
      balance_after_amount: "100.00",
      reference_attempts: 0,
      next_attempt_at: null,
      processed_at: at(SECOND),
    });
    expect(await s.snapshot(target)).toEqual({ balance: "100.00", version: 3 });
    expect(await s.movements(target)).toEqual([
      { direction: "DEBIT", amount: "25.00", balanceAfter: "75.00" },
      { direction: "CREDIT", amount: "25.00", balanceAfter: "100.00" },
    ]);
    expect((await ledgerOf(s.client, target.id))[2]?.transaction_id).toBe(
      refund.body.transactionId,
    );
    expect(await s.eventTypes(refund.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("a transação ainda não devida não é tocada (nem 1ms antes)", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
    const refund = await s.pendingReversal(
      target,
      "REFUND",
      original.externalTransactionId,
      "25.00",
    );
    await s.send(original);
    const before = await s.row(refund.body.transactionId);

    const early = await s.tickAfter(SECOND - 1);

    expect(early).toMatchObject({ candidates: 0, processed: 0 });
    expect(await s.row(refund.body.transactionId)).toEqual(before);
    expect(await s.tickAfter(1)).toMatchObject({ candidates: 1, processed: 1 });
  });

  test("ROLLBACK de BET que chega depois => CREDIT", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("40.00") });
    const rollback = await s.pendingReversal(
      target,
      "ROLLBACK",
      original.externalTransactionId,
      "40.00",
    );
    await s.send(original);

    await s.tickAfter(SECOND);

    expect((await s.row(rollback.body.transactionId)).status).toBe("PROCESSED");
    expect(await s.movements(target)).toEqual([
      { direction: "DEBIT", amount: "40.00", balanceAfter: "60.00" },
      { direction: "CREDIT", amount: "40.00", balanceAfter: "100.00" },
    ]);
  });

  test("ROLLBACK de WIN que chega depois => DEBIT", async () => {
    const target = await s.wallet("100.00");
    const prize = s.futurePayload(target, { kind: "WIN", money: money("50.00") });
    const rollback = await s.pendingReversal(
      target,
      "ROLLBACK",
      prize.externalTransactionId,
      "50.00",
    );
    await s.send(prize);

    await s.tickAfter(SECOND);

    expect((await s.row(rollback.body.transactionId)).status).toBe("PROCESSED");
    expect(await s.movements(target)).toEqual([
      { direction: "CREDIT", amount: "50.00", balanceAfter: "150.00" },
      { direction: "DEBIT", amount: "50.00", balanceAfter: "100.00" },
    ]);
    expect(await s.eventTypes(rollback.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("ROLLBACK de REFUND que chega depois => DEBIT", async () => {
    const target = await s.wallet("100.00");
    const original = await s.processed(target, { kind: "BET", money: money("25.00") });
    const refundPayload = s.futurePayload(target, {
      kind: "REFUND",
      referenceExternalTransactionId: original.payload.externalTransactionId,
      money: money("25.00"),
    });
    const rollback = await s.pendingReversal(
      target,
      "ROLLBACK",
      refundPayload.externalTransactionId,
      "25.00",
    );
    expect((await s.send(refundPayload)).status).toBe(200);

    await s.tickAfter(SECOND);

    expect((await s.row(rollback.body.transactionId)).status).toBe("PROCESSED");
    expect(await s.movements(target)).toEqual([
      { direction: "DEBIT", amount: "25.00", balanceAfter: "75.00" },
      { direction: "CREDIT", amount: "25.00", balanceAfter: "100.00" },
      { direction: "DEBIT", amount: "25.00", balanceAfter: "75.00" },
    ]);
  });

  test("WIN com referência a uma BET que chega depois => credita e guarda a BET como referência", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("10.00") });
    const prize = await s.pending(target, {
      kind: "WIN",
      referenceExternalTransactionId: original.externalTransactionId,
      money: money("30.00"),
    });
    const bet = await s.send(original);

    await s.tickAfter(SECOND);

    expect(await s.row(prize.body.transactionId)).toMatchObject({
      status: "PROCESSED",
      reference_transaction_id: bet.body.transactionId,
      balance_after_amount: "120.00",
    });
    expect(await s.balanceOf(target)).toBe("120.00");
  });

  test("LOSS com referência a uma BET que chega depois => PROCESSED sem lançamento e sem WalletBalanceChanged", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("10.00") });
    const loss = await s.pending(target, {
      kind: "LOSS",
      referenceExternalTransactionId: original.externalTransactionId,
      money: money("10.00"),
    });
    await s.send(original);

    await s.tickAfter(SECOND);

    expect((await s.row(loss.body.transactionId)).status).toBe("PROCESSED");
    expect(await s.movements(target)).toHaveLength(1);
    expect(await s.eventTypes(loss.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
    ]);
  });

  test("uma transação já resolvida não é reprocessada em ticks seguintes", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
    await s.pendingReversal(target, "REFUND", original.externalTransactionId, "25.00");
    await s.send(original);
    await s.tickAfter(SECOND);
    const counts = await tableCounts(s.client);

    expect(await s.tickAfter(SECOND)).toMatchObject({ candidates: 0 });
    expect(await s.tickAfter(60 * SECOND)).toMatchObject({ candidates: 0 });
    expect(await tableCounts(s.client)).toEqual(counts);
  });

  test("P7: o replay com a mesma Idempotency-Key devolve 202 antes, e o resultado final depois", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
    const refund = await s.pendingReversal(
      target,
      "REFUND",
      original.externalTransactionId,
      "25.00",
    );
    await s.send(original);

    const before = await s.send(refund.payload);
    expect(before.status).toBe(202);
    expect(before.body).toMatchObject({ status: "PENDING_REFERENCE", idempotentReplay: true });

    await s.tickAfter(SECOND);
    const after = await s.send(refund.payload);

    expect(after.status).toBe(200);
    expect(after.body).toEqual({
      transactionId: refund.body.transactionId,
      status: "PROCESSED",
      balance: money("100.00"),
      idempotentReplay: true,
    });
    expect(await s.eventTypes(refund.body.transactionId)).toHaveLength(3);
  });

  test("P7: replay de uma pendência que o worker rejeitou devolve o 422 final", async () => {
    const target = await s.wallet("20.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("80.00") });
    const refund = await s.pendingReversal(
      target,
      "REFUND",
      original.externalTransactionId,
      "80.00",
    );
    expect((await s.send(original)).status).toBe(422);

    await s.tickAfter(SECOND);
    const replay = await s.send(refund.payload);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({
      transactionId: refund.body.transactionId,
      status: "REJECTED",
      failureCode: "REFERENCE_NOT_PROCESSED",
      balance: money("20.00"),
      idempotentReplay: true,
    });
  });
});

describe("worker de PENDING_REFERENCE: o worker aplica as mesmas regras do fluxo normal", () => {
  const s = useScenario();

  test("ROLLBACK pendente de WIN cujo prêmio já foi gasto => REJECTED REVERSAL_INSUFFICIENT_FUNDS, saldo intacto e sem ledger", async () => {
    const target = await s.wallet("100.00");
    const prize = s.futurePayload(target, { kind: "WIN", money: money("50.00") });
    const rollback = await s.pendingReversal(
      target,
      "ROLLBACK",
      prize.externalTransactionId,
      "50.00",
    );
    await s.send(prize);
    await s.processed(target, { kind: "BET", money: money("140.00") });
    expect(await s.snapshot(target)).toEqual({ balance: "10.00", version: 3 });

    const report = await s.tickAfter(SECOND);

    expect(report).toMatchObject({ rejected: 1, processed: 0 });
    expect(await s.row(rollback.body.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REVERSAL_INSUFFICIENT_FUNDS",
      balance_after_amount: "10.00",
      next_attempt_at: null,
    });
    expect(await s.snapshot(target)).toEqual({ balance: "10.00", version: 3 });
    expect(await s.movements(target)).toHaveLength(2);
    expect(await s.eventTypes(rollback.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
  });

  const rejections: [
    string,
    string,
    (target: OpenedWallet) => Promise<{
      reference: string;
      overrides?: Record<string, unknown>;
      amount: string;
      arrive: () => Promise<unknown>;
    }>,
  ][] = [
    [
      "REFERENCE_AMOUNT_MISMATCH",
      "valor diferente do da BET",
      async (target) => {
        const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
        return {
          reference: original.externalTransactionId,
          amount: "24.00",
          arrive: () => s.send(original),
        };
      },
    ],
    [
      "REFERENCE_ROUND_MISMATCH",
      "rodada diferente da BET",
      async (target) => {
        const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
        return {
          reference: original.externalTransactionId,
          amount: "25.00",
          overrides: { roundId: "round-2" },
          arrive: () => s.send(original),
        };
      },
    ],
    [
      "REFERENCE_KIND_NOT_ALLOWED",
      "REFUND de uma WIN",
      async (target) => {
        const prize = s.futurePayload(target, { kind: "WIN", money: money("25.00") });
        return {
          reference: prize.externalTransactionId,
          amount: "25.00",
          arrive: () => s.send(prize),
        };
      },
    ],
    [
      "REFERENCE_NOT_PROCESSED",
      "BET que chegou e foi rejeitada",
      async (target) => {
        const original = s.futurePayload(target, { kind: "BET", money: money("500.00") });
        return {
          reference: original.externalTransactionId,
          amount: "500.00",
          arrive: () => s.send(original),
        };
      },
    ],
    [
      "REFERENCE_ALREADY_REVERSED",
      "BET que enquanto isso já foi reembolsada",
      async (target) => {
        const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
        return {
          reference: original.externalTransactionId,
          amount: "25.00",
          arrive: async () => {
            await s.send(original);
            await s.processed(target, {
              kind: "REFUND",
              referenceExternalTransactionId: original.externalTransactionId,
              money: money("25.00"),
            });
          },
        };
      },
    ],
  ];

  for (const [failureCode, description, scenario] of rejections) {
    test(`${failureCode}: ${description}`, async () => {
      const target = await s.wallet("100.00");
      const { reference, amount, overrides, arrive } = await scenario(target);
      const pending = await s.pendingReversal(target, "REFUND", reference, amount, overrides);
      await arrive();
      const balanceBefore = await s.balanceOf(target);
      const ledgerBefore = (await s.movements(target)).length;

      const report = await s.tickAfter(SECOND);

      expect(report).toMatchObject({ rejected: 1, processed: 0, failed: 0 });
      expect(await s.row(pending.body.transactionId)).toMatchObject({
        status: "REJECTED",
        failure_code: failureCode,
        balance_after_amount: balanceBefore,
        next_attempt_at: null,
      });
      expect(await s.balanceOf(target)).toBe(balanceBefore);
      expect((await s.movements(target)).length).toBe(ledgerBefore);
      expect(await s.eventTypes(pending.body.transactionId)).toEqual([
        "WagerTransactionPendingReference",
        "WagerTransactionRejected",
      ]);
    });
  }

  test("o evento Rejected carrega o failureCode e a Idempotency-Key como causationId", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
    const refund = await s.pendingReversal(
      target,
      "REFUND",
      original.externalTransactionId,
      "20.00",
    );
    await s.send(original);
    await s.tickAfter(SECOND);

    const events = await eventsOfTransaction(s.client, refund.body.transactionId);
    const rejected = events.find((event) => event.event_type === "WagerTransactionRejected");

    expect(rejected?.payload.causationId).toBe(
      `${refund.payload.providerId}:${refund.payload.externalTransactionId}`,
    );
    expect(rejected?.payload.data).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_AMOUNT_MISMATCH",
    });
  });

  test("referência existente mas ainda PENDING: continua PENDING_REFERENCE, conta a tentativa e NÃO emite outro PendingReference", async () => {
    const target = await s.wallet("100.00");
    const seeded = await s.seedTransaction(target, "PENDING");
    const refund = await s.pendingReversal(target, "REFUND", seeded.externalId, "25.00");

    const report = await s.tickAfter(SECOND);

    expect(report).toMatchObject({ candidates: 1, rescheduled: 1, processed: 0, rejected: 0 });
    expect(await s.row(refund.body.transactionId)).toMatchObject({
      status: "PENDING_REFERENCE",
      reference_attempts: 1,
      next_attempt_at: at(SECOND + 2 * SECOND),
      balance_after_amount: null,
    });
    expect(await s.eventTypes(refund.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
    ]);
    expect(await s.snapshot(target)).toEqual({ balance: "100.00", version: 1 });
  });

  test("referência PENDING_REFERENCE também continua aguardando", async () => {
    const target = await s.wallet("100.00");
    const seeded = await s.seedTransaction(target, "PENDING_REFERENCE");
    const prize = await s.pending(target, {
      kind: "WIN",
      referenceExternalTransactionId: seeded.externalId,
      money: money("25.00"),
    });

    expect(await s.tickAfter(SECOND)).toMatchObject({ rescheduled: 1 });
    expect((await s.row(prize.body.transactionId)).status).toBe("PENDING_REFERENCE");
  });

  test("referência PENDING que depois vira REJECTED => REFERENCE_NOT_PROCESSED", async () => {
    const target = await s.wallet("100.00");
    const seeded = await s.seedTransaction(target, "PENDING");
    const refund = await s.pendingReversal(target, "REFUND", seeded.externalId, "25.00");
    expect(await s.tickAfter(SECOND)).toMatchObject({ rescheduled: 1 });
    await s.client.query(
      `update wager_transactions
          set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS',
              balance_after_amount = 100.00, processed_at = now()
        where id = $1`,
      [seeded.id],
    );

    const next = (await s.row(refund.body.transactionId)).next_attempt_at as Date;
    const report = await s.tickAt(next);

    expect(report).toMatchObject({ rejected: 1 });
    expect(await s.row(refund.body.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_PROCESSED",
    });
  });

  test("referência PENDING que depois vira PROCESSED => a pendência é aplicada", async () => {
    const target = await s.wallet("100.00");
    const seeded = await s.seedTransaction(target, "PENDING");
    const refund = await s.pendingReversal(target, "REFUND", seeded.externalId, "25.00");
    expect(await s.tickAfter(SECOND)).toMatchObject({ rescheduled: 1 });
    await s.client.query(
      `update wager_transactions
          set status = 'PROCESSED', balance_after_amount = 100.00, processed_at = now()
        where id = $1`,
      [seeded.id],
    );

    const next = (await s.row(refund.body.transactionId)).next_attempt_at as Date;
    await s.tickAt(next);

    expect(await s.row(refund.body.transactionId)).toMatchObject({
      status: "PROCESSED",
      reference_attempts: 1,
      next_attempt_at: null,
    });
    expect(await s.balanceOf(target)).toBe("125.00");
  });
});

describe("worker de PENDING_REFERENCE: cadeias", () => {
  const s = useScenario();

  test("ROLLBACK pendente de uma WIN que também está pendente resolve em ticks sucessivos, na ordem certa", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
    const prize = s.futurePayload(target, {
      kind: "WIN",
      referenceExternalTransactionId: original.externalTransactionId,
      money: money("60.00"),
    });
    const rollback = await s.pendingReversal(
      target,
      "ROLLBACK",
      prize.externalTransactionId,
      "60.00",
    );
    const pendingWin = await s.send(prize);
    expect(pendingWin.status).toBe(202);
    expect((await s.send(original)).status).toBe(200);

    const first = await s.tickAfter(SECOND);

    expect(first).toMatchObject({ candidates: 2, processed: 1, rescheduled: 1 });
    expect((await s.row(pendingWin.body.transactionId)).status).toBe("PROCESSED");
    expect(await s.row(rollback.body.transactionId)).toMatchObject({
      status: "PENDING_REFERENCE",
      reference_attempts: 1,
    });
    expect(await s.balanceOf(target)).toBe("135.00");

    const second = await s.tickAt(at(SECOND + 2 * SECOND));

    expect(second).toMatchObject({ candidates: 1, processed: 1 });
    expect((await s.row(rollback.body.transactionId)).status).toBe("PROCESSED");
    expect(await s.movements(target)).toEqual([
      { direction: "DEBIT", amount: "25.00", balanceAfter: "75.00" },
      { direction: "CREDIT", amount: "60.00", balanceAfter: "135.00" },
      { direction: "DEBIT", amount: "60.00", balanceAfter: "75.00" },
    ]);
    expect(await s.eventTypes(rollback.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("se o prêmio pendente acaba rejeitado, o ROLLBACK dele termina REFERENCE_NOT_PROCESSED", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("500.00") });
    const prize = s.futurePayload(target, {
      kind: "WIN",
      referenceExternalTransactionId: original.externalTransactionId,
      money: money("60.00"),
    });
    const rollback = await s.pendingReversal(
      target,
      "ROLLBACK",
      prize.externalTransactionId,
      "60.00",
    );
    const pendingWin = await s.send(prize);
    expect((await s.send(original)).status).toBe(422);

    await s.tickAfter(SECOND);
    await s.tickAt(at(SECOND + 2 * SECOND));

    expect((await s.row(pendingWin.body.transactionId)).failure_code).toBe(
      "REFERENCE_NOT_PROCESSED",
    );
    expect((await s.row(rollback.body.transactionId)).failure_code).toBe("REFERENCE_NOT_PROCESSED");
    expect(await s.balanceOf(target)).toBe("100.00");
  });
});

describe("worker de PENDING_REFERENCE: backoff exponencial", () => {
  const s = useScenario();

  test("os next_attempt_at seguem 1s, 2s, 4s, 8s, 16s, 32s e ficam presos no teto de 60s", async () => {
    const target = await s.wallet("100.00");
    const pending = await s.pendingReversal(target, "REFUND", "nunca-chega", "25.00");
    expect((await s.row(pending.body.transactionId)).next_attempt_at).toEqual(at(1 * SECOND));

    const expectedDelays = [2, 4, 8, 16, 32, 60, 60, 60, 60];
    let totalMs = 0;

    for (const [index, seconds] of expectedDelays.entries()) {
      const due = (await s.row(pending.body.transactionId)).next_attempt_at as Date;
      const report = await s.tickAt(due);
      const row = await s.row(pending.body.transactionId);

      expect(report).toMatchObject({ rescheduled: 1, exhausted: 0 });
      expect(row.status).toBe("PENDING_REFERENCE");
      expect(row.reference_attempts).toBe(index + 1);
      expect((row.next_attempt_at as Date).getTime() - due.getTime()).toBe(seconds * SECOND);
      totalMs += seconds * SECOND;
    }

    expect(totalMs).toBeLessThan(15 * 60 * SECOND);
  });

  test("tentativas sem referência não emitem eventos novos", async () => {
    const target = await s.wallet("100.00");
    const pending = await s.pendingReversal(target, "REFUND", "nunca-chega", "25.00");

    for (let attempt = 0; attempt < 5; attempt++) {
      await s.tickAt((await s.row(pending.body.transactionId)).next_attempt_at as Date);
    }

    expect(await s.eventTypes(pending.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
    ]);
    expect(await s.snapshot(target)).toEqual({ balance: "100.00", version: 1 });
  });

  test("com os limites padrão, a 10ª tentativa sem referência rejeita com REFERENCE_NOT_FOUND", async () => {
    const target = await s.wallet("100.00");
    const pending = await s.pendingReversal(target, "REFUND", "nunca-chega", "25.00");

    for (let attempt = 1; attempt < 10; attempt++) {
      const report = await s.tickAt(
        (await s.row(pending.body.transactionId)).next_attempt_at as Date,
      );
      expect(report).toMatchObject({ rescheduled: 1 });
    }
    const last = await s.tickAt((await s.row(pending.body.transactionId)).next_attempt_at as Date);

    expect(last).toMatchObject({ exhausted: 1, rescheduled: 0 });
    expect(await s.row(pending.body.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
      reference_attempts: 10,
      next_attempt_at: null,
    });
  });
});

describe("worker de PENDING_REFERENCE: limite por tentativas", () => {
  const s = useScenario({
    PENDING_REFERENCE_MAX_ATTEMPTS: "3",
    PENDING_REFERENCE_TTL_MS: "3600000",
  });

  test("referência nunca chega: após 3 tentativas => REJECTED REFERENCE_NOT_FOUND + evento Rejected, saldo intacto", async () => {
    const target = await s.wallet("100.00");
    const pending = await s.pendingReversal(target, "REFUND", "nunca-chega", "25.00");

    expect(await s.tickAt(at(1 * SECOND))).toMatchObject({ rescheduled: 1 });
    expect(await s.tickAt(at(3 * SECOND))).toMatchObject({ rescheduled: 1 });
    expect((await s.row(pending.body.transactionId)).status).toBe("PENDING_REFERENCE");
    const last = await s.tickAt(at(7 * SECOND));

    expect(last).toMatchObject({ exhausted: 1, rescheduled: 0, processed: 0 });
    expect(await s.row(pending.body.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
      reference_attempts: 3,
      balance_after_amount: "100.00",
      next_attempt_at: null,
      processed_at: at(7 * SECOND),
    });
    expect(await s.snapshot(target)).toEqual({ balance: "100.00", version: 1 });
    expect(await s.movements(target)).toEqual([]);
    expect(await s.eventTypes(pending.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    const events = await eventsOfTransaction(s.client, pending.body.transactionId);
    expect(events[1]?.payload.data).toMatchObject({ failureCode: "REFERENCE_NOT_FOUND" });
  });

  test("a rejeição por esgotamento vira o resultado final no replay (422)", async () => {
    const target = await s.wallet("100.00");
    const pending = await s.pendingReversal(target, "ROLLBACK", "nunca-chega", "25.00");
    for (const offset of [1, 3, 7]) {
      await s.tickAt(at(offset * SECOND));
    }

    const replay = await s.send(pending.payload);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({
      transactionId: pending.body.transactionId,
      status: "REJECTED",
      failureCode: "REFERENCE_NOT_FOUND",
      balance: money("100.00"),
      idempotentReplay: true,
    });
  });

  test("referência existente mas que nunca saiu de PENDING até o limite => REFERENCE_NOT_PROCESSED (não NOT_FOUND)", async () => {
    const target = await s.wallet("100.00");
    const seeded = await s.seedTransaction(target, "PENDING");
    const pending = await s.pendingReversal(target, "REFUND", seeded.externalId, "25.00");

    await s.tickAt(at(1 * SECOND));
    await s.tickAt(at(3 * SECOND));
    await s.tickAt(at(7 * SECOND));

    expect(await s.row(pending.body.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_PROCESSED",
      reference_attempts: 3,
    });
  });

  test("se a referência chega exatamente na última tentativa, ela vence o limite", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
    const pending = await s.pendingReversal(
      target,
      "REFUND",
      original.externalTransactionId,
      "25.00",
    );
    await s.tickAt(at(1 * SECOND));
    await s.tickAt(at(3 * SECOND));
    await s.send(original);

    const last = await s.tickAt(at(7 * SECOND));

    expect(last).toMatchObject({ processed: 1, exhausted: 0 });
    expect((await s.row(pending.body.transactionId)).status).toBe("PROCESSED");
    expect(await s.balanceOf(target)).toBe("100.00");
  });
});

describe("worker de PENDING_REFERENCE: limite por tempo (TTL)", () => {
  const s = useScenario({
    PENDING_REFERENCE_MAX_ATTEMPTS: "100",
    PENDING_REFERENCE_TTL_MS: "10000",
  });

  test("referência nunca chega: passados 10s desde a criação => REJECTED REFERENCE_NOT_FOUND, mesmo com poucas tentativas", async () => {
    const target = await s.wallet("100.00");
    const pending = await s.pendingReversal(target, "REFUND", "nunca-chega", "25.00");

    expect(await s.tickAt(at(1 * SECOND))).toMatchObject({ rescheduled: 1 });
    expect(await s.tickAt(at(3 * SECOND))).toMatchObject({ rescheduled: 1 });
    expect(await s.tickAt(at(7 * SECOND))).toMatchObject({ rescheduled: 1 });
    expect((await s.row(pending.body.transactionId)).status).toBe("PENDING_REFERENCE");

    const last = await s.tickAt(at(15 * SECOND));

    expect(last).toMatchObject({ exhausted: 1 });
    expect(await s.row(pending.body.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
      reference_attempts: 4,
      balance_after_amount: "100.00",
    });
    expect(await s.eventTypes(pending.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    expect(await s.snapshot(target)).toEqual({ balance: "100.00", version: 1 });
  });

  test("o TTL conta desde a criação, não desde a última tentativa: exatamente 10s já esgota", async () => {
    const target = await s.wallet("100.00");
    const pending = await s.pendingReversal(target, "REFUND", "nunca-chega", "25.00");
    s.clock.set(at(10 * SECOND));
    await s.client.query("update wager_transactions set next_attempt_at = $2 where id = $1", [
      pending.body.transactionId,
      at(10 * SECOND),
    ]);

    const report = await s.tickAt(at(10 * SECOND));

    expect(report).toMatchObject({ exhausted: 1 });
  });

  test("um instante antes do TTL ainda reagenda", async () => {
    const target = await s.wallet("100.00");
    const pending = await s.pendingReversal(target, "REFUND", "nunca-chega", "25.00");
    await s.client.query("update wager_transactions set next_attempt_at = $2 where id = $1", [
      pending.body.transactionId,
      at(10 * SECOND - 1),
    ]);

    const report = await s.tickAt(at(10 * SECOND - 1));

    expect(report).toMatchObject({ rescheduled: 1, exhausted: 0 });
  });

  test("referência existente mas PENDING até o TTL => REFERENCE_NOT_PROCESSED", async () => {
    const target = await s.wallet("100.00");
    const seeded = await s.seedTransaction(target, "PENDING");
    const pending = await s.pendingReversal(target, "REFUND", seeded.externalId, "25.00");
    await s.tickAt(at(1 * SECOND));

    await s.tickAt(at(30 * SECOND));

    expect((await s.row(pending.body.transactionId)).failure_code).toBe("REFERENCE_NOT_PROCESSED");
  });

  test("se a referência chegou mas o worker só voltou depois do TTL, a pendência ainda é resolvida (a referência vence o tempo)", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
    const pending = await s.pendingReversal(
      target,
      "REFUND",
      original.externalTransactionId,
      "25.00",
    );
    await s.send(original);

    const report = await s.tickAt(at(60 * SECOND));

    expect(report).toMatchObject({ processed: 1, exhausted: 0 });
    expect((await s.row(pending.body.transactionId)).status).toBe("PROCESSED");
  });
});

describe("worker de PENDING_REFERENCE: candidatos velhos e falhas isoladas", () => {
  let stale: PendingReferenceCandidate[] | undefined;
  const s = useScenario(
    { PENDING_WORKER_BATCH_SIZE: "5" },
    {
      lockTimeoutMs: 300,
      wrapUnitOfWork: (real) => ({
        run: (work) =>
          real.run((repositories) => {
            if (!stale) {
              return work(repositories);
            }

            const forced = stale;
            const transactions = Object.assign(Object.create(repositories.transactions), {
              findDueForReference: async () => forced,
            });

            return work({ ...repositories, transactions });
          }),
      }),
    },
  );

  const withStale = async <T>(candidates: PendingReferenceCandidate[], body: () => Promise<T>) => {
    stale = candidates;
    try {
      return await body();
    } finally {
      stale = undefined;
    }
  };

  test("relê depois do lock: candidato que outra instância já PROCESSOU é ignorado, sem segundo lançamento", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
    const refund = await s.pendingReversal(
      target,
      "REFUND",
      original.externalTransactionId,
      "25.00",
    );
    await s.send(original);
    await s.tickAfter(SECOND);
    const counts = await tableCounts(s.client);
    const version = (await s.snapshot(target)).version;

    const report = await withStale(
      [{ transactionId: refund.body.transactionId, walletId: target.id }],
      () => s.tickAfter(SECOND),
    );

    expect(report).toMatchObject({ candidates: 1, skipped: 1, processed: 0, failed: 0 });
    expect(await tableCounts(s.client)).toEqual(counts);
    expect((await s.snapshot(target)).version).toBe(version);
  });

  test("relê depois do lock: candidato que outra instância já REJEITOU é ignorado", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
    const refund = await s.pendingReversal(
      target,
      "REFUND",
      original.externalTransactionId,
      "20.00",
    );
    await s.send(original);
    await s.tickAfter(SECOND);
    expect((await s.row(refund.body.transactionId)).status).toBe("REJECTED");
    const counts = await tableCounts(s.client);

    const report = await withStale(
      [{ transactionId: refund.body.transactionId, walletId: target.id }],
      () => s.tickAfter(SECOND),
    );

    expect(report).toMatchObject({ skipped: 1, failed: 0 });
    expect(await tableCounts(s.client)).toEqual(counts);
  });

  test("relê depois do lock: candidato já reagendado para o futuro por outra instância não é tentado de novo", async () => {
    const target = await s.wallet("100.00");
    const pending = await s.pendingReversal(target, "REFUND", "nunca-chega", "25.00");
    await s.tickAfter(SECOND);
    const before = await s.row(pending.body.transactionId);
    expect(before.reference_attempts).toBe(1);

    const report = await withStale(
      [{ transactionId: pending.body.transactionId, walletId: target.id }],
      () => s.tickAfter(0),
    );

    expect(report).toMatchObject({ skipped: 1, rescheduled: 0 });
    expect(await s.row(pending.body.transactionId)).toEqual(before);
  });

  test("candidato inexistente na releitura é ignorado", async () => {
    const target = await s.wallet("100.00");

    const report = await withStale(
      [{ transactionId: crypto.randomUUID(), walletId: target.id }],
      () => s.tickAfter(SECOND),
    );

    expect(report).toMatchObject({ skipped: 1, failed: 0 });
  });

  test("lock timeout em um candidato não derruba o lote: os demais são processados e o falho volta no tick seguinte", async () => {
    const blocked = await s.wallet("100.00");
    const free = await s.wallet("100.00");
    const blockedBet = s.futurePayload(blocked, { kind: "BET", money: money("25.00") });
    const freeBet = s.futurePayload(free, { kind: "BET", money: money("25.00") });
    const blockedRefund = await s.pendingReversal(
      blocked,
      "REFUND",
      blockedBet.externalTransactionId,
      "25.00",
    );
    const freeRefund = await s.pendingReversal(
      free,
      "REFUND",
      freeBet.externalTransactionId,
      "25.00",
    );
    await s.send(blockedBet);
    await s.send(freeBet);

    const holder: Client = await s.api.db.connect();
    await holder.query("begin");
    await holder.query("select id from wallets where id = $1 for update", [blocked.id]);

    let report: Awaited<ReturnType<typeof s.tickAfter>>;
    try {
      report = await s.tickAfter(SECOND);
    } finally {
      await holder.query("rollback");
    }

    expect(report).toMatchObject({ candidates: 2, processed: 1, failed: 1 });
    expect((await s.row(freeRefund.body.transactionId)).status).toBe("PROCESSED");
    expect(await s.row(blockedRefund.body.transactionId)).toMatchObject({
      status: "PENDING_REFERENCE",
      reference_attempts: 0,
      next_attempt_at: at(SECOND),
    });

    const retry = await s.tickAfter(0);

    expect(retry).toMatchObject({ candidates: 1, processed: 1, failed: 0 });
    expect((await s.row(blockedRefund.body.transactionId)).status).toBe("PROCESSED");
    expect(await s.balanceOf(blocked)).toBe("100.00");
  });

  test("ordem dos locks: enquanto espera a wallet, o worker NÃO segura a linha da transação", async () => {
    const target = await s.wallet("100.00");
    const original = s.futurePayload(target, { kind: "BET", money: money("25.00") });
    const refund = await s.pendingReversal(
      target,
      "REFUND",
      original.externalTransactionId,
      "25.00",
    );
    await s.send(original);
    const holder: Client = await s.api.db.connect();
    await holder.query("begin");
    await holder.query("select id from wallets where id = $1 for update", [target.id]);
    const probe: Client = await s.api.db.connect();

    let report: Awaited<ReturnType<typeof s.tickAfter>>;
    let transactionRowWasFree = false;
    try {
      const ticking = s.tickAfter(SECOND);
      await waitUntilSomeoneWaitsOnLock(s.client);
      await probe.query("begin");
      try {
        await probe.query("select id from wager_transactions where id = $1 for update nowait", [
          refund.body.transactionId,
        ]);
        transactionRowWasFree = true;
      } catch {
        transactionRowWasFree = false;
      }
      await probe.query("rollback");
      report = await ticking;
    } finally {
      await holder.query("rollback");
    }

    expect(transactionRowWasFree).toBe(true);
    expect(report).toMatchObject({ failed: 1, processed: 0 });
    expect((await s.row(refund.body.transactionId)).status).toBe("PENDING_REFERENCE");
  });

  test("o lote pega primeiro as mais antigas (next_attempt_at), não as primeiras inseridas", async () => {
    const target = await s.wallet("100.00");
    const created = [];
    for (let index = 0; index < 7; index++) {
      created.push(await s.pendingReversal(target, "REFUND", `nunca-chega-${index}`, "1.00"));
    }
    for (const [index, pending] of created.entries()) {
      await s.client.query("update wager_transactions set next_attempt_at = $2 where id = $1", [
        pending.body.transactionId,
        at(SECOND * (10 - index)),
      ]);
    }

    const report = await s.tickAt(at(20 * SECOND));

    expect(report).toMatchObject({ candidates: 5, rescheduled: 5 });
    const attempts: number[] = [];
    for (const pending of created) {
      attempts.push((await s.row(pending.body.transactionId)).reference_attempts);
    }
    expect(attempts).toEqual([0, 0, 1, 1, 1, 1, 1]);
  });

  test("só PENDING_REFERENCE é candidata, mesmo que outra linha tenha next_attempt_at vencido", async () => {
    const target = await s.wallet("100.00");
    await s.seedTransaction(target, "PENDING", { next_attempt_at: T0 });
    await s.seedTransaction(target, "PROCESSED", {
      next_attempt_at: T0,
      balance_after_amount: "100.00",
    });
    await s.seedTransaction(target, "FAILED", { next_attempt_at: T0 });

    const report = await s.tickAt(at(SECOND));

    expect(report.candidates).toBe(0);
  });

  test("o lote respeita o batchSize e processa o restante no tick seguinte", async () => {
    const target = await s.wallet("1000.00");
    const batch = 5;
    const total = batch + 3;
    const originals = Array.from({ length: total }, () =>
      s.futurePayload(target, { kind: "BET", money: money("1.00") }),
    );
    for (const original of originals) {
      await s.pendingReversal(target, "REFUND", original.externalTransactionId, "1.00");
    }
    for (const original of originals) {
      await s.send(original);
    }

    const first = await s.tickAfter(SECOND);
    const second = await s.tickAfter(0);

    expect(first).toMatchObject({ candidates: batch, processed: batch });
    expect(second).toMatchObject({ candidates: 3, processed: 3 });
    expect(await s.balanceOf(target)).toBe("1000.00");
  });

  test("uma wallet sem nada pendente deixa o tick vazio", async () => {
    await openWallet(s.api.http, "100.00");

    expect(await s.tickAfter(SECOND)).toEqual({
      candidates: 0,
      processed: 0,
      rejected: 0,
      exhausted: 0,
      rescheduled: 0,
      skipped: 0,
      failed: 0,
    });
  });
});
