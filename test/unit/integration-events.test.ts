import { describe, expect, test } from "bun:test";
import { WagerTransactionPendingReference } from "../../src/modules/wagering/domain/events/wager-transaction-pending-reference";
import { WagerTransactionProcessed } from "../../src/modules/wagering/domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../../src/modules/wagering/domain/events/wager-transaction-rejected";
import { FailureCode } from "../../src/modules/wagering/domain/failure-code";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/wager-transaction";
import { WalletBalanceChanged } from "../../src/modules/wallet/domain/events/wallet-balance-changed";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import {
  IntegrationEvent,
  InvalidIntegrationEventError,
} from "../../src/shared/events/integration-event";
import { containsMoneyInstance } from "../support/contains-money";
import { aContext, aLedgerEntry, aTransaction, brl } from "../support/wagering-builders";

const ENVELOPE = {
  eventId: "evt-1",
  correlationId: "corr-1",
  causationId: "cause-1",
  occurredAt: "2026-01-01T12:00:00.000Z",
  version: 1,
};

const TRANSACTION_DATA = {
  transactionId: "tx-1",
  providerId: "provider-a",
  externalTransactionId: "ext-1",
  walletId: "wallet-1",
  playerId: "player-1",
  roundId: "round-1",
  gameId: "game-1",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

const processedTransaction = (overrides = {}) =>
  aTransaction({
    status: WagerTransactionStatus.Processed,
    balanceAfter: brl("75.00"),
    processedAt: new Date("2026-01-01T12:00:00.000Z"),
    ...overrides,
  });

const rejectedTransaction = (overrides = {}) =>
  aTransaction({
    status: WagerTransactionStatus.Rejected,
    failureCode: FailureCode.InsufficientFunds,
    balanceAfter: brl("20.00"),
    processedAt: new Date("2026-01-01T12:00:00.000Z"),
    ...overrides,
  });

const pendingReferenceTransaction = (overrides = {}) =>
  aTransaction({
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: "ext-0",
    status: WagerTransactionStatus.PendingReference,
    ...overrides,
  });

describe("WalletBalanceChanged", () => {
  test("toJSON tem o formato exato do CHALLENGE.md §11, com aggregateId = walletId", () => {
    const event = WalletBalanceChanged.from(aLedgerEntry(), aContext());

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      ...ENVELOPE,
      eventType: "WalletBalanceChanged",
      aggregateId: "wallet-1",
      data: {
        walletId: "wallet-1",
        transactionId: "tx-1",
        direction: "DEBIT",
        money: { amount: "80.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "20.00", currency: "BRL" },
        walletVersion: 2,
      },
    });
  });

  test("eventType e version ficam no tipo", () => {
    const event = WalletBalanceChanged.from(aLedgerEntry(), aContext());

    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(event.eventType).toBe("WalletBalanceChanged");
    expect(event.version).toBe(1);
  });

  test("crédito: direção CREDIT e saldos coerentes", () => {
    const entry = aLedgerEntry({
      direction: LedgerDirection.Credit,
      money: brl("60.00"),
      balanceBefore: brl("975.00"),
      balanceAfter: brl("1035.00"),
      walletVersion: 3,
    });

    const { data } = WalletBalanceChanged.from(entry, aContext()).toJSON();

    expect<string>(data.direction).toBe("CREDIT");
    expect(data.balanceBefore.amount).toBe("975.00");
    expect(data.balanceAfter.amount).toBe("1035.00");
    expect(data.walletVersion).toBe(3);
  });

  test("data carrega MoneyProps com string decimal, nunca instância de Money", () => {
    const event = WalletBalanceChanged.from(aLedgerEntry(), aContext());

    expect(containsMoneyInstance(event.data)).toBe(false);
    expect(containsMoneyInstance(event.toJSON())).toBe(false);
    for (const money of [event.data.money, event.data.balanceBefore, event.data.balanceAfter]) {
      expect(typeof money.amount).toBe("string");
      expect(money.amount).toMatch(/^\d+\.\d{2}$/);
    }
  });

  test("o payload sobrevive a JSON.stringify e parse sem perder nada", () => {
    const event = WalletBalanceChanged.from(aLedgerEntry(), aContext());

    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });
});

describe("WagerTransactionProcessed", () => {
  test("toJSON tem o formato exato, com aggregateId = transactionId", () => {
    const event = WagerTransactionProcessed.from(processedTransaction(), aContext());

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      ...ENVELOPE,
      eventType: "WagerTransactionProcessed",
      aggregateId: "tx-1",
      data: {
        ...TRANSACTION_DATA,
        status: "PROCESSED",
        balanceAfter: { amount: "75.00", currency: "BRL" },
      },
    });
  });

  test("inclui as referências quando existem", () => {
    const transaction = processedTransaction({
      kind: WagerTransactionKind.Win,
      referenceExternalTransactionId: "ext-0",
      referenceTransactionId: "tx-0",
    });

    const { data } = WagerTransactionProcessed.from(transaction, aContext()).toJSON();

    expect<string>(data.kind).toBe("WIN");
    expect(data.referenceExternalTransactionId).toBe("ext-0");
    expect(data.referenceTransactionId).toBe("tx-0");
  });

  test("sem referência, as chaves de referência não aparecem", () => {
    const { data } = WagerTransactionProcessed.from(processedTransaction(), aContext()).toJSON();

    expect("referenceExternalTransactionId" in data).toBe(false);
    expect("referenceTransactionId" in data).toBe(false);
  });

  test("LOSS e OPENING também geram o evento (qualquer transação aplicada)", () => {
    for (const kind of [WagerTransactionKind.Loss, WagerTransactionKind.Opening]) {
      const event = WagerTransactionProcessed.from(processedTransaction({ kind }), aContext());

      expect(event.data.kind).toBe(kind);
    }
  });

  test("eventType, version e ausência de Money na data", () => {
    const event = WagerTransactionProcessed.from(processedTransaction(), aContext());

    expect(event.eventType).toBe("WagerTransactionProcessed");
    expect(event.version).toBe(1);
    expect(containsMoneyInstance(event.toJSON())).toBe(false);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  test("rejeita transação que não está PROCESSED ou sem saldo observado", () => {
    const wrongStatuses = [
      WagerTransactionStatus.Pending,
      WagerTransactionStatus.PendingReference,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ];

    for (const status of wrongStatuses) {
      expect(() =>
        WagerTransactionProcessed.from(
          aTransaction({ status, balanceAfter: brl("1.00") }),
          aContext(),
        ),
      ).toThrow(InvalidIntegrationEventError);
    }
    expect(() =>
      WagerTransactionProcessed.from(
        aTransaction({ status: WagerTransactionStatus.Processed }),
        aContext(),
      ),
    ).toThrow(InvalidIntegrationEventError);
  });
});

describe("WagerTransactionRejected", () => {
  test("toJSON tem o formato exato, com failureCode e sem saldo", () => {
    const event = WagerTransactionRejected.from(rejectedTransaction(), aContext());

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      ...ENVELOPE,
      eventType: "WagerTransactionRejected",
      aggregateId: "tx-1",
      data: {
        ...TRANSACTION_DATA,
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
      },
    });
  });

  test("propaga qualquer failureCode e a referência pedida", () => {
    const transaction = rejectedTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "ext-0",
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });

    const { data } = WagerTransactionRejected.from(transaction, aContext()).toJSON();

    expect<string>(data.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    expect(data.referenceExternalTransactionId).toBe("ext-0");
  });

  test("eventType, version e ausência de Money na data", () => {
    const event = WagerTransactionRejected.from(rejectedTransaction(), aContext());

    expect(event.eventType).toBe("WagerTransactionRejected");
    expect(event.version).toBe(1);
    expect(containsMoneyInstance(event.toJSON())).toBe(false);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  test("rejeita transação que não está REJECTED ou sem failureCode", () => {
    const wrongStatuses = [
      WagerTransactionStatus.Pending,
      WagerTransactionStatus.PendingReference,
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Failed,
    ];

    for (const status of wrongStatuses) {
      expect(() =>
        WagerTransactionRejected.from(
          aTransaction({ status, failureCode: FailureCode.InsufficientFunds }),
          aContext(),
        ),
      ).toThrow(InvalidIntegrationEventError);
    }
    expect(() =>
      WagerTransactionRejected.from(
        aTransaction({ status: WagerTransactionStatus.Rejected }),
        aContext(),
      ),
    ).toThrow(InvalidIntegrationEventError);
  });
});

describe("WagerTransactionPendingReference", () => {
  test("toJSON tem o formato exato, informando qual referência se espera", () => {
    const event = WagerTransactionPendingReference.from(pendingReferenceTransaction(), aContext());

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      ...ENVELOPE,
      eventType: "WagerTransactionPendingReference",
      aggregateId: "tx-1",
      data: {
        ...TRANSACTION_DATA,
        kind: "REFUND",
        status: "PENDING_REFERENCE",
        referenceExternalTransactionId: "ext-0",
      },
    });
  });

  test("eventType, version e ausência de Money na data", () => {
    const event = WagerTransactionPendingReference.from(pendingReferenceTransaction(), aContext());

    expect(event.eventType).toBe("WagerTransactionPendingReference");
    expect(event.version).toBe(1);
    expect(containsMoneyInstance(event.toJSON())).toBe(false);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  test("rejeita transação que não está PENDING_REFERENCE ou sem referência", () => {
    const wrongStatuses = [
      WagerTransactionStatus.Pending,
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ];

    for (const status of wrongStatuses) {
      expect(() =>
        WagerTransactionPendingReference.from(pendingReferenceTransaction({ status }), aContext()),
      ).toThrow(InvalidIntegrationEventError);
    }
    expect(() =>
      WagerTransactionPendingReference.from(
        pendingReferenceTransaction({ referenceExternalTransactionId: undefined }),
        aContext(),
      ),
    ).toThrow(InvalidIntegrationEventError);
  });
});

describe("eventos de integração: propriedades comuns", () => {
  const everyEvent = (context = aContext()) => [
    WalletBalanceChanged.from(aLedgerEntry(), context),
    WagerTransactionProcessed.from(processedTransaction(), context),
    WagerTransactionRejected.from(rejectedTransaction(), context),
    WagerTransactionPendingReference.from(pendingReferenceTransaction(), context),
  ];

  test("os quatro eventTypes são distintos e estáveis", () => {
    expect(everyEvent().map((event) => event.eventType)).toEqual([
      "WalletBalanceChanged",
      "WagerTransactionProcessed",
      "WagerTransactionRejected",
      "WagerTransactionPendingReference",
    ]);
  });

  test("o contexto (ids e instante) vai inteiro para o envelope", () => {
    const context = aContext({
      eventId: "evt-9",
      correlationId: "corr-9",
      causationId: "msg-9",
      occurredAt: new Date("2026-03-04T05:06:07.890Z"),
    });

    for (const event of everyEvent(context)) {
      const json = event.toJSON();

      expect(json.eventId).toBe("evt-9");
      expect(json.correlationId).toBe("corr-9");
      expect(json.causationId).toBe("msg-9");
      expect(json.occurredAt).toBe("2026-03-04T05:06:07.890Z");
    }
  });

  test("sem causationId no contexto, ele some do envelope de todos os eventos", () => {
    for (const event of everyEvent(aContext({ causationId: undefined }))) {
      expect("causationId" in event.toJSON()).toBe(false);
    }
  });

  test("criar o evento não altera a transação nem o lançamento de origem", () => {
    const transaction: WagerTransaction = processedTransaction();

    WagerTransactionProcessed.from(transaction, aContext());

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.balanceAfter?.toJSON().amount).toBe("75.00");
  });

  test("o erro de origem inválida é de domínio, com código estável", () => {
    try {
      WagerTransactionProcessed.from(aTransaction(), aContext());
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidIntegrationEventError).code).toBe("INTEGRATION_EVENT_INVALID_SOURCE");
    }
  });
});
