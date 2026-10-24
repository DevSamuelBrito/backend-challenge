import { describe, expect, test } from "bun:test";
import { FailureCode } from "../../src/modules/wagering/domain/failure-code";
import {
  evaluateReference,
  type ReferenceDecision,
} from "../../src/modules/wagering/domain/reference-policy";
import {
  type WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/wager-transaction";
import { aProcessed, aTransaction, brl, usd } from "../support/wagering-builders";

const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;
const { Pending, PendingReference, Processed, Rejected, Failed } = WagerTransactionStatus;

function incoming(
  kind: WagerTransactionKind,
  overrides: Partial<WagerTransactionState> = {},
): WagerTransaction {
  return aTransaction({
    id: "tx-new",
    externalTransactionId: "ext-new",
    kind,
    referenceExternalTransactionId: "ext-ref",
    ...overrides,
  });
}

function referenced(overrides: Partial<WagerTransactionState> = {}): WagerTransaction {
  return aProcessed({
    id: "tx-ref",
    externalTransactionId: "ext-ref",
    kind: Bet,
    ...overrides,
  });
}

const rejects = (failureCode: FailureCode): ReferenceDecision => ({
  status: Rejected,
  failureCode,
});
const pending: ReferenceDecision = { status: PendingReference };
const proceeds = (referenceTransactionId: string | undefined): ReferenceDecision => ({
  status: Processed,
  referenceTransactionId,
});

describe("evaluateReference: transações que não usam referência", () => {
  test.each([[Bet], [Opening]])("%s segue sem referência", (kind) => {
    expect(
      evaluateReference(incoming(kind), { reference: undefined, alreadyReversed: false }),
    ).toEqual(proceeds(undefined));
  });

  test.each([[Win], [Loss]])("%s sem referência informada segue (P4)", (kind) => {
    const transaction = incoming(kind, { referenceExternalTransactionId: undefined });

    expect(
      evaluateReference(transaction, { reference: undefined, alreadyReversed: false }),
    ).toEqual(proceeds(undefined));
  });
});

describe("evaluateReference: referência ausente (regra 8)", () => {
  test.each([[Refund], [Rollback], [Win], [Loss]])(
    "%s com referência ainda não recebida fica PENDING_REFERENCE",
    (kind) => {
      expect(
        evaluateReference(incoming(kind), { reference: undefined, alreadyReversed: false }),
      ).toEqual(pending);
    },
  );
});

describe("evaluateReference: referência válida", () => {
  test.each([
    [Refund, Bet],
    [Rollback, Bet],
    [Rollback, Win],
    [Rollback, Refund],
    [Win, Bet],
    [Loss, Bet],
  ])(
    "%s referenciando %s processada segue e guarda o id interno da referência",
    (kind, refKind) => {
      const decision = evaluateReference(incoming(kind), {
        reference: referenced({ kind: refKind }),
        alreadyReversed: false,
      });

      expect(decision).toEqual(proceeds("tx-ref"));
    },
  );

  test("WIN pode ter valor diferente da BET (só reversões exigem valor igual)", () => {
    const decision = evaluateReference(incoming(Win, { money: brl("250.00") }), {
      reference: referenced({ money: brl("25.00") }),
      alreadyReversed: false,
    });

    expect(decision).toEqual(proceeds("tx-ref"));
  });

  test("alreadyReversed não afeta WIN nem LOSS", () => {
    for (const kind of [Win, Loss]) {
      expect(
        evaluateReference(incoming(kind), { reference: referenced(), alreadyReversed: true }),
      ).toEqual(proceeds("tx-ref"));
    }
  });

  test("a decisão não altera a transação avaliada", () => {
    const transaction = incoming(Refund);

    evaluateReference(transaction, { reference: referenced(), alreadyReversed: false });

    expect(transaction.status).toBe(Pending);
    expect(transaction.failureCode).toBeUndefined();
  });

  test("também avalia uma transação que já estava em PENDING_REFERENCE", () => {
    const decision = evaluateReference(incoming(Refund, { status: PendingReference }), {
      reference: referenced(),
      alreadyReversed: false,
    });

    expect(decision).toEqual(proceeds("tx-ref"));
  });
});

describe("evaluateReference: tipo da referência (REFERENCE_KIND_NOT_ALLOWED)", () => {
  test.each([
    [Refund, Win],
    [Refund, Loss],
    [Refund, Refund],
    [Refund, Rollback],
    [Refund, Opening],
    [Rollback, Loss],
    [Rollback, Rollback],
    [Rollback, Opening],
    [Win, Win],
    [Win, Loss],
    [Win, Refund],
    [Win, Rollback],
    [Win, Opening],
    [Loss, Win],
    [Loss, Loss],
    [Loss, Refund],
    [Loss, Rollback],
    [Loss, Opening],
  ])("%s referenciando %s é rejeitada", (kind, refKind) => {
    const decision = evaluateReference(incoming(kind), {
      reference: referenced({ kind: refKind }),
      alreadyReversed: false,
    });

    expect(decision).toEqual(rejects(FailureCode.ReferenceKindNotAllowed));
  });
});

describe("evaluateReference: contexto da referência (D7)", () => {
  const cases: [string, Partial<WagerTransactionState>, FailureCode][] = [
    ["outra rodada", { roundId: "round-2" }, FailureCode.ReferenceRoundMismatch],
    ["outra wallet", { walletId: "wallet-2" }, FailureCode.ReferenceWalletMismatch],
    ["outro player", { playerId: "player-2" }, FailureCode.ReferencePlayerMismatch],
    ["outra moeda", { money: usd("25.00") }, FailureCode.ReferenceCurrencyMismatch],
  ];

  for (const [description, referenceOverrides, failureCode] of cases) {
    test.each([[Refund], [Rollback], [Win], [Loss]])(
      `%s com referência de ${description} é rejeitada com ${failureCode}`,
      (kind) => {
        const decision = evaluateReference(incoming(kind), {
          reference: referenced(referenceOverrides),
          alreadyReversed: false,
        });

        expect(decision).toEqual(rejects(failureCode));
      },
    );
  }

  test("o contexto é imutável: referência divergente ainda PENDING é rejeitada na hora", () => {
    const decision = evaluateReference(incoming(Refund), {
      reference: referenced({ status: Pending, roundId: "round-2" }),
      alreadyReversed: false,
    });

    expect(decision).toEqual(rejects(FailureCode.ReferenceRoundMismatch));
  });

  test("cada divergência tem failureCode distinto", () => {
    const codes = cases.map(([, referenceOverrides]) => {
      const decision = evaluateReference(incoming(Refund), {
        reference: referenced(referenceOverrides),
        alreadyReversed: false,
      });

      return decision.status === Rejected ? decision.failureCode : undefined;
    });

    expect(new Set(codes).size).toBe(cases.length);
  });
});

describe("evaluateReference: valor da reversão (regra 5)", () => {
  test.each([[Refund], [Rollback]])("%s com valor diferente da referência é rejeitada", (kind) => {
    for (const money of [brl("24.99"), brl("25.01"), brl("50.00")]) {
      const decision = evaluateReference(incoming(kind, { money }), {
        reference: referenced({ money: brl("25.00") }),
        alreadyReversed: false,
      });

      expect(decision).toEqual(rejects(FailureCode.ReferenceAmountMismatch));
    }
  });

  test("moeda diferente é reportada como moeda, não como valor", () => {
    const decision = evaluateReference(incoming(Refund, { money: usd("30.00") }), {
      reference: referenced({ money: brl("25.00") }),
      alreadyReversed: false,
    });

    expect(decision).toEqual(rejects(FailureCode.ReferenceCurrencyMismatch));
  });
});

describe("evaluateReference: situação da referência (P5)", () => {
  test.each([[Refund], [Rollback], [Win], [Loss]])(
    "%s cuja referência está REJECTED ou FAILED é rejeitada",
    (kind) => {
      for (const status of [Rejected, Failed]) {
        const decision = evaluateReference(incoming(kind), {
          reference: referenced({ status }),
          alreadyReversed: false,
        });

        expect(decision).toEqual(rejects(FailureCode.ReferenceNotProcessed));
      }
    },
  );

  test.each([[Refund], [Rollback], [Win], [Loss]])(
    "%s cuja referência está PENDING ou PENDING_REFERENCE continua aguardando",
    (kind) => {
      for (const status of [Pending, PendingReference]) {
        const decision = evaluateReference(incoming(kind), {
          reference: referenced({ status }),
          alreadyReversed: false,
        });

        expect(decision).toEqual(pending);
      }
    },
  );
});

describe("evaluateReference: reversão única (D4)", () => {
  test.each([[Refund], [Rollback]])("%s de referência já revertida é rejeitada", (kind) => {
    const decision = evaluateReference(incoming(kind), {
      reference: referenced(),
      alreadyReversed: true,
    });

    expect(decision).toEqual(rejects(FailureCode.ReferenceAlreadyReversed));
  });

  test("vale para qualquer combinação de tipos: ROLLBACK de BET já reembolsada", () => {
    const decision = evaluateReference(incoming(Rollback), {
      reference: referenced({ kind: Bet }),
      alreadyReversed: true,
    });

    expect(decision).toEqual(rejects(FailureCode.ReferenceAlreadyReversed));
  });

  test("a mesma referência, ainda não revertida, é aceita", () => {
    const decision = evaluateReference(incoming(Refund), {
      reference: referenced(),
      alreadyReversed: false,
    });

    expect(decision).toEqual(proceeds("tx-ref"));
  });
});

describe("evaluateReference: precedência das regras", () => {
  test("tipo não permitido vem antes de qualquer divergência de contexto", () => {
    const decision = evaluateReference(incoming(Refund), {
      reference: referenced({ kind: Win, walletId: "wallet-2", roundId: "round-2" }),
      alreadyReversed: false,
    });

    expect(decision).toEqual(rejects(FailureCode.ReferenceKindNotAllowed));
  });

  test("divergência de contexto vem antes da situação da referência", () => {
    const decision = evaluateReference(incoming(Refund), {
      reference: referenced({ status: Rejected, playerId: "player-2" }),
      alreadyReversed: false,
    });

    expect(decision).toEqual(rejects(FailureCode.ReferencePlayerMismatch));
  });

  test("valor divergente vem antes da situação da referência", () => {
    const decision = evaluateReference(incoming(Refund, { money: brl("1.00") }), {
      reference: referenced({ status: Rejected }),
      alreadyReversed: false,
    });

    expect(decision).toEqual(rejects(FailureCode.ReferenceAmountMismatch));
  });

  test("situação da referência vem antes de já revertida", () => {
    const decision = evaluateReference(incoming(Refund), {
      reference: referenced({ status: Pending }),
      alreadyReversed: true,
    });

    expect(decision).toEqual(pending);
  });
});
