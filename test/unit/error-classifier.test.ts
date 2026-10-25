import { describe, expect, test } from "bun:test";
import { InboxPayloadMismatchError } from "../../src/modules/messaging/domain/messaging-errors";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidTransactionStateError,
} from "../../src/modules/wagering/domain/wager-transaction-errors";
import {
  classifyError,
  type PermanentReason,
  type TransientReason,
} from "../../src/modules/wagering/messaging/error-classifier";
import {
  MalformedMessageError,
  UnexpectedMessageTypeError,
} from "../../src/modules/wagering/messaging/message-errors";
import { WalletNotFoundError } from "../../src/modules/wallet/domain/wallet-errors";
import { InvalidRequestError } from "../../src/shared/application/invalid-request-error";
import { LockTimeoutError } from "../../src/shared/application/persistence-errors";
import { DomainError } from "../../src/shared/domain/domain-error";
import { InvalidMoneyError, MoneyOutOfRangeError } from "../../src/shared/domain/money";

describe("classifyError: tabela de erros do consumidor", () => {
  const permanent: [string, unknown, PermanentReason][] = [
    ["JSON malformado", new MalformedMessageError("x"), "MALFORMED_MESSAGE"],
    ["type inesperado", new UnexpectedMessageTypeError("Outro"), "UNEXPECTED_MESSAGE_TYPE"],
    ["payload inválido", new InvalidRequestError("x"), "INVALID_PAYLOAD"],
    ["dinheiro inválido", new InvalidMoneyError("x"), "INVALID_PAYLOAD"],
    ["dinheiro fora do limite", new MoneyOutOfRangeError(), "INVALID_PAYLOAD"],
    [
      "transição inválida (bug de domínio)",
      new InvalidTransactionStateError("A", "B"),
      "INVALID_PAYLOAD",
    ],
    ["wallet inexistente", new WalletNotFoundError("w"), "WALLET_NOT_FOUND"],
    ["conflito de idempotência", new IdempotencyConflictError("k"), "IDEMPOTENCY_CONFLICT"],
    [
      "conflito de transação externa",
      new ExternalTransactionConflictError("p", "e"),
      "EXTERNAL_TRANSACTION_CONFLICT",
    ],
    [
      "inbox com hash divergente",
      new InboxPayloadMismatchError("c", "m"),
      "INBOX_PAYLOAD_MISMATCH",
    ],
  ];

  for (const [name, error, reason] of permanent) {
    test(`${name} é permanente (${reason})`, () => {
      expect(classifyError(error)).toEqual({ kind: "permanent", reason });
    });
  }

  const transient: [string, unknown, TransientReason][] = [
    ["lock timeout", new LockTimeoutError(100), "LOCK_TIMEOUT"],
    [
      "conexão recusada",
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      "DATABASE_UNAVAILABLE",
    ],
    [
      "banco desligando (57P01)",
      Object.assign(new Error("terminating connection"), { code: "57P01" }),
      "DATABASE_UNAVAILABLE",
    ],
    [
      "classe 08 (exceção de conexão)",
      Object.assign(new Error("connection failure"), { code: "08006" }),
      "DATABASE_UNAVAILABLE",
    ],
    [
      "erro de conexão embrulhado em outro erro",
      new Error("driver", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
      "DATABASE_UNAVAILABLE",
    ],
    ["erro genérico desconhecido", new Error("???"), "UNEXPECTED_ERROR"],
    ["TypeError", new TypeError("undefined is not a function"), "UNEXPECTED_ERROR"],
    ["valor lançado que não é Error", "texto solto", "UNEXPECTED_ERROR"],
    ["undefined", undefined, "UNEXPECTED_ERROR"],
    ["null", null, "UNEXPECTED_ERROR"],
  ];

  for (const [name, error, reason] of transient) {
    test(`${name} é transitório (${reason})`, () => {
      expect(classifyError(error)).toEqual({ kind: "transient", reason });
    });
  }

  test("o erro de lock timeout tem precedência sobre qualquer outra regra", () => {
    const error = Object.assign(new LockTimeoutError(100), { code: "08006" });

    expect(classifyError(error)).toEqual({ kind: "transient", reason: "LOCK_TIMEOUT" });
  });

  test("um DomainError qualquer, ainda sem regra própria, é tratado como payload inválido (o equivalente ao 400)", () => {
    class SomethingNew extends DomainError {
      readonly code = "SOMETHING_NEW";
    }

    expect(classifyError(new SomethingNew("x"))).toEqual({
      kind: "permanent",
      reason: "INVALID_PAYLOAD",
    });
  });

  test("o código de um erro de conexão não é confundido com um erro de negócio com o mesmo prefixo no texto", () => {
    expect(classifyError(new Error("08 não é um código"))).toEqual({
      kind: "transient",
      reason: "UNEXPECTED_ERROR",
    });
  });
});
