import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/modules/wagering/domain/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/wager-transaction";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "../../src/modules/wagering/domain/wager-transaction-errors";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import { DomainError } from "../../src/shared/domain/domain-error";
import { AT, aTransaction, brl, createProps } from "../support/wagering-builders";

const LATER = new Date("2026-01-02T08:30:00.000Z");
const ALL_STATUSES = Object.values(WagerTransactionStatus);
const ALL_KINDS = Object.values(WagerTransactionKind);

describe("WagerTransaction.create", () => {
  test("nasce em PENDING sem resultado nem falha", () => {
    const transaction = WagerTransaction.create(createProps());

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.balanceAfter).toBeUndefined();
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.isTerminal()).toBe(false);
  });

  test("preserva os campos informados", () => {
    const transaction = WagerTransaction.create(
      createProps({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-0",
        money: brl("12.34"),
      }),
    );

    expect(transaction.id).toBe("tx-1");
    expect(transaction.providerId).toBe("provider-a");
    expect(transaction.externalTransactionId).toBe("ext-1");
    expect(transaction.idempotencyKey).toBe("provider-a:ext-1");
    expect(transaction.payloadHash).toBe("hash-1");
    expect(transaction.walletId).toBe("wallet-1");
    expect(transaction.playerId).toBe("player-1");
    expect(transaction.roundId).toBe("round-1");
    expect(transaction.gameId).toBe("game-1");
    expect(transaction.kind).toBe(WagerTransactionKind.Refund);
    expect(transaction.money.toJSON().amount).toBe("12.34");
    expect(transaction.referenceExternalTransactionId).toBe("ext-0");
    expect(transaction.createdAt).toBe(AT);
  });

  test.each([[WagerTransactionKind.Refund], [WagerTransactionKind.Rollback]])(
    "%s sem referência é rejeitado como payload inválido",
    (kind) => {
      for (const referenceExternalTransactionId of [undefined, ""]) {
        try {
          WagerTransaction.create(createProps({ kind, referenceExternalTransactionId }));
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(DomainError);
          expect((error as InvalidWagerTransactionError).code).toBe("WAGER_REFERENCE_REQUIRED");
        }
      }
    },
  );

  test.each([
    [WagerTransactionKind.Bet],
    [WagerTransactionKind.Win],
    [WagerTransactionKind.Loss],
    [WagerTransactionKind.Opening],
  ])("%s não exige referência", (kind) => {
    expect(() => WagerTransaction.create(createProps({ kind }))).not.toThrow();
  });

  test.each([[WagerTransactionKind.Win], [WagerTransactionKind.Loss]])(
    "%s aceita referência opcional (P4)",
    (kind) => {
      const transaction = WagerTransaction.create(
        createProps({ kind, referenceExternalTransactionId: "ext-0" }),
      );

      expect(transaction.hasReference()).toBe(true);
    },
  );

  test("rejeita valor zero (D5)", () => {
    try {
      WagerTransaction.create(createProps({ money: brl("0.00") }));
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidWagerTransactionError).code).toBe("WAGER_AMOUNT_NOT_POSITIVE");
    }
  });

  test("rejeita valor negativo", () => {
    expect(() => WagerTransaction.create(createProps({ money: brl("1.00").negate() }))).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe("WagerTransaction.rehydrate", () => {
  test("reconstrói qualquer estado, inclusive terminal, sem revalidar", () => {
    const transaction = aTransaction({
      kind: WagerTransactionKind.Refund,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
      balanceAfter: brl("10.00"),
      processedAt: LATER,
      referenceTransactionId: "tx-0",
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(transaction.balanceAfter?.toJSON().amount).toBe("10.00");
    expect(transaction.processedAt).toBe(LATER);
    expect(transaction.referenceTransactionId).toBe("tx-0");
    expect(transaction.isTerminal()).toBe(true);
  });

  test("não revalida regras de criação: REFUND sem referência e valor zero", () => {
    const transaction = aTransaction({
      kind: WagerTransactionKind.Refund,
      money: brl("0.00"),
      referenceExternalTransactionId: undefined,
    });

    expect(transaction.kind).toBe(WagerTransactionKind.Refund);
    expect(transaction.money.isZero()).toBe(true);
  });
});

describe("WagerTransaction: máquina de estados", () => {
  const apply = (transaction: WagerTransaction, target: WagerTransactionStatus): void => {
    switch (target) {
      case WagerTransactionStatus.Processed:
        transaction.markProcessed(undefined, brl("1.00"), LATER);
        return;
      case WagerTransactionStatus.Rejected:
        transaction.reject(FailureCode.InsufficientFunds, brl("1.00"), LATER);
        return;
      case WagerTransactionStatus.PendingReference:
        transaction.markPendingReference();
        return;
      case WagerTransactionStatus.Failed:
        transaction.fail(FailureCode.ProcessingFailed, LATER);
        return;
      case WagerTransactionStatus.Pending:
        throw new Error("PENDING não é destino de nenhuma transição");
    }
  };

  const VALID: Record<WagerTransactionStatus, WagerTransactionStatus[]> = {
    [WagerTransactionStatus.Pending]: [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.PendingReference,
      WagerTransactionStatus.Failed,
    ],
    [WagerTransactionStatus.PendingReference]: [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ],
    [WagerTransactionStatus.Processed]: [],
    [WagerTransactionStatus.Rejected]: [],
    [WagerTransactionStatus.Failed]: [],
  };

  const targets = ALL_STATUSES.filter((status) => status !== WagerTransactionStatus.Pending);

  for (const from of ALL_STATUSES) {
    for (const to of targets) {
      const allowed = VALID[from].includes(to);

      test(`${from} → ${to} ${allowed ? "é permitida" : "lança InvalidTransactionStateError"}`, () => {
        const transaction = aTransaction({ status: from });

        if (allowed) {
          apply(transaction, to);
          expect(transaction.status).toBe(to);
        } else {
          expect(() => apply(transaction, to)).toThrow(InvalidTransactionStateError);
          expect(transaction.status).toBe(from);
        }
      });
    }
  }

  test("o erro é de domínio, tem código estável e cita origem e destino", () => {
    const transaction = aTransaction({ status: WagerTransactionStatus.Processed });

    try {
      transaction.reject(FailureCode.InsufficientFunds, brl("1.00"), LATER);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as InvalidTransactionStateError).code).toBe("INVALID_TRANSACTION_STATE");
      expect((error as InvalidTransactionStateError).message).toContain("PROCESSED");
      expect((error as InvalidTransactionStateError).message).toContain("REJECTED");
    }
  });

  test("PENDING_REFERENCE não volta a PENDING_REFERENCE (o worker só conta tentativas)", () => {
    const transaction = aTransaction({ status: WagerTransactionStatus.PendingReference });

    expect(() => transaction.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test("transição inválida não altera nenhum dado da transação", () => {
    const transaction = aTransaction({
      status: WagerTransactionStatus.Processed,
      balanceAfter: brl("100.00"),
      processedAt: AT,
    });

    expect(() => transaction.reject(FailureCode.InsufficientFunds, brl("1.00"), LATER)).toThrow();
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.balanceAfter?.toJSON().amount).toBe("100.00");
    expect(transaction.processedAt).toBe(AT);
  });

  test("isTerminal é verdadeiro só para PROCESSED, REJECTED e FAILED", () => {
    const terminal = ALL_STATUSES.filter((status) => aTransaction({ status }).isTerminal());

    expect(terminal.sort()).toEqual(
      [
        WagerTransactionStatus.Processed,
        WagerTransactionStatus.Rejected,
        WagerTransactionStatus.Failed,
      ].sort(),
    );
  });
});

describe("WagerTransaction: efeito de cada transição", () => {
  test("markProcessed guarda a referência, o saldo observado e o instante", () => {
    const transaction = aTransaction();

    transaction.markProcessed("tx-0", brl("75.00"), LATER);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe("tx-0");
    expect(transaction.balanceAfter?.toJSON().amount).toBe("75.00");
    expect(transaction.processedAt).toBe(LATER);
    expect(transaction.failureCode).toBeUndefined();
  });

  test("markProcessed aceita transação sem referência", () => {
    const transaction = aTransaction();

    transaction.markProcessed(undefined, brl("75.00"), LATER);

    expect(transaction.referenceTransactionId).toBeUndefined();
  });

  test("reject guarda o failureCode, o saldo observado e o instante", () => {
    const transaction = aTransaction();

    transaction.reject(FailureCode.InsufficientFunds, brl("20.00"), LATER);

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.balanceAfter?.toJSON().amount).toBe("20.00");
    expect(transaction.processedAt).toBe(LATER);
  });

  test("fail guarda o failureCode e o instante, sem saldo", () => {
    const transaction = aTransaction();

    transaction.fail(FailureCode.ProcessingFailed, LATER);

    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(transaction.failureCode).toBe(FailureCode.ProcessingFailed);
    expect(transaction.balanceAfter).toBeUndefined();
    expect(transaction.processedAt).toBe(LATER);
  });

  test("markPendingReference não define resultado", () => {
    const transaction = aTransaction();

    transaction.markPendingReference();

    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.failureCode).toBeUndefined();
  });

  test("PENDING_REFERENCE resolve para PROCESSED guardando a referência encontrada", () => {
    const transaction = aTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "ext-0",
    });

    transaction.markPendingReference();
    transaction.markProcessed("tx-0", brl("125.00"), LATER);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe("tx-0");
  });
});

describe("WagerTransaction: consultas de domínio", () => {
  test("requiresReference é verdadeiro só para REFUND e ROLLBACK", () => {
    const required = ALL_KINDS.filter((kind) => aTransaction({ kind }).requiresReference());

    expect(required.sort()).toEqual(
      [WagerTransactionKind.Refund, WagerTransactionKind.Rollback].sort(),
    );
  });

  test("affectsBalance é falso só para LOSS", () => {
    const withoutEffect = ALL_KINDS.filter((kind) => !aTransaction({ kind }).affectsBalance());

    expect(withoutEffect).toEqual([WagerTransactionKind.Loss]);
  });

  test("hasReference reflete o referenceExternalTransactionId", () => {
    expect(aTransaction().hasReference()).toBe(false);
    expect(aTransaction({ referenceExternalTransactionId: "" }).hasReference()).toBe(false);
    expect(aTransaction({ referenceExternalTransactionId: "ext-0" }).hasReference()).toBe(true);
  });

  test("matchesPayload compara o hash do payload", () => {
    const transaction = aTransaction({ payloadHash: "abc" });

    expect(transaction.matchesPayload("abc")).toBe(true);
    expect(transaction.matchesPayload("abd")).toBe(false);
  });

  test("insufficientFundsFailureCode distingue aposta de reversão (regra 9)", () => {
    expect(aTransaction({ kind: WagerTransactionKind.Bet }).insufficientFundsFailureCode()).toBe(
      FailureCode.InsufficientFunds,
    );
    expect(aTransaction({ kind: WagerTransactionKind.Refund }).insufficientFundsFailureCode()).toBe(
      FailureCode.ReversalInsufficientFunds,
    );
    expect(
      aTransaction({ kind: WagerTransactionKind.Rollback }).insufficientFundsFailureCode(),
    ).toBe(FailureCode.ReversalInsufficientFunds);
  });

  test.each([
    [WagerTransactionKind.Win],
    [WagerTransactionKind.Loss],
    [WagerTransactionKind.Opening],
  ])("insufficientFundsFailureCode não se aplica a %s", (kind) => {
    expect(() => aTransaction({ kind }).insufficientFundsFailureCode()).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe("WagerTransaction.ledgerDirectionFor", () => {
  test.each([
    [WagerTransactionKind.Bet, LedgerDirection.Debit],
    [WagerTransactionKind.Win, LedgerDirection.Credit],
    [WagerTransactionKind.Refund, LedgerDirection.Credit],
    [WagerTransactionKind.Opening, LedgerDirection.Credit],
  ])("%s → %s", (kind, direction) => {
    expect(aTransaction({ kind }).ledgerDirectionFor()).toBe(direction);
  });

  test("LOSS não gera lançamento", () => {
    try {
      aTransaction({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor();
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidWagerTransactionError).code).toBe("WAGER_NO_LEDGER_ENTRY");
    }
  });

  test.each([
    [WagerTransactionKind.Bet, LedgerDirection.Credit],
    [WagerTransactionKind.Win, LedgerDirection.Debit],
    [WagerTransactionKind.Refund, LedgerDirection.Debit],
  ])("ROLLBACK de %s inverte para %s", (referenceKind, direction) => {
    const rollback = aTransaction({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "ext-0",
    });
    const reference = aTransaction({ kind: referenceKind });

    expect(rollback.ledgerDirectionFor(reference)).toBe(direction);
  });

  test("ROLLBACK sem a referência não sabe qual lançamento inverter", () => {
    const rollback = aTransaction({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "ext-0",
    });

    try {
      rollback.ledgerDirectionFor();
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidWagerTransactionError).code).toBe("WAGER_REFERENCE_REQUIRED");
    }
  });

  test.each([
    [WagerTransactionKind.Loss],
    [WagerTransactionKind.Rollback],
    [WagerTransactionKind.Opening],
  ])("ROLLBACK não reverte %s", (referenceKind) => {
    const rollback = aTransaction({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: "ext-0",
    });

    try {
      rollback.ledgerDirectionFor(aTransaction({ kind: referenceKind }));
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidWagerTransactionError).code).toBe("WAGER_INVALID_REFERENCE_KIND");
    }
  });
});
