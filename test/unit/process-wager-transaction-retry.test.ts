import { describe, expect, test } from "bun:test";
import { ProcessWagerTransaction } from "../../src/modules/wagering/application/process-wager-transaction";
import { parseProcessWagerTransactionCommand } from "../../src/modules/wagering/application/process-wager-transaction.command";
import {
  type DuplicatedConstraint,
  DuplicateTransactionError,
  KindNotSupportedYetError,
} from "../../src/modules/wagering/application/wagering-errors";
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
} from "../../src/modules/wagering/domain/wager-transaction-errors";
import type { UnitOfWork } from "../../src/shared/application/unit-of-work.port";
import { FixedClock, SequentialIdGenerator } from "../support/doubles";

const command = (overrides: Record<string, unknown> = {}) =>
  parseProcessWagerTransactionCommand({
    idempotencyKey: "chave-1",
    payload: {
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      playerId: "player-1",
      walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
      ...overrides,
    },
  });

function scriptedUnitOfWork(outcomes: (() => unknown)[]) {
  const state = { runs: 0 };
  const unitOfWork: UnitOfWork = {
    run: async () => {
      const outcome =
        outcomes[state.runs] ??
        (() => {
          throw new Error("run chamado mais vezes que o previsto");
        });
      state.runs += 1;
      return outcome() as never;
    },
  };

  return { state, useCase: build(unitOfWork) };
}

function build(unitOfWork: UnitOfWork) {
  return new ProcessWagerTransaction(
    unitOfWork,
    new FixedClock(new Date("2026-01-01T00:00:00.000Z")),
    new SequentialIdGenerator(),
  );
}

const duplicate = (constraint: DuplicatedConstraint) => () => {
  throw new DuplicateTransactionError(constraint);
};

describe("ProcessWagerTransaction: política de retry após violação de unicidade", () => {
  test("a violação na primeira tentativa dispara exatamente uma segunda transação, e o resultado dela é devolvido", async () => {
    const sentinel = { transactionId: "t", idempotentReplay: true };
    const { state, useCase } = scriptedUnitOfWork([duplicate("idempotency_key"), () => sentinel]);

    expect(await useCase.execute(command())).toBe(sentinel as never);
    expect(state.runs).toBe(2);
  });

  test("se o retry também violar a chave de idempotência, vira IdempotencyConflictError (409), nunca erro cru", async () => {
    const { state, useCase } = scriptedUnitOfWork([
      duplicate("idempotency_key"),
      duplicate("idempotency_key"),
    ]);

    const failure = await useCase.execute(command()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IdempotencyConflictError);
    expect((failure as IdempotencyConflictError).message).toContain("chave-1");
    expect(state.runs).toBe(2);
  });

  test("se o retry violar (provedor, id externo), vira ExternalTransactionConflictError (409)", async () => {
    const { state, useCase } = scriptedUnitOfWork([
      duplicate("external_transaction"),
      duplicate("external_transaction"),
    ]);

    const failure = await useCase.execute(command()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExternalTransactionConflictError);
    expect((failure as ExternalTransactionConflictError).message).toContain("ext-1");
    expect(state.runs).toBe(2);
  });

  test("o conflito reportado é o da violação do RETRY, não o da primeira tentativa", async () => {
    const { useCase } = scriptedUnitOfWork([
      duplicate("idempotency_key"),
      duplicate("external_transaction"),
    ]);

    const failure = await useCase.execute(command()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExternalTransactionConflictError);
  });

  test("nunca há mais de um retry: a terceira tentativa não existe", async () => {
    const { state, useCase } = scriptedUnitOfWork([
      duplicate("idempotency_key"),
      duplicate("idempotency_key"),
      duplicate("idempotency_key"),
    ]);

    await useCase.execute(command()).catch(() => undefined);

    expect(state.runs).toBe(2);
  });

  test("outros erros não disparam retry e chegam intactos", async () => {
    const boom = new Error("erro qualquer");
    const { state, useCase } = scriptedUnitOfWork([
      () => {
        throw boom;
      },
    ]);

    await expect(useCase.execute(command())).rejects.toBe(boom);
    expect(state.runs).toBe(1);
  });

  test("um erro diferente no retry também chega intacto", async () => {
    const boom = new Error("falha no retry");
    const { state, useCase } = scriptedUnitOfWork([
      duplicate("idempotency_key"),
      () => {
        throw boom;
      },
    ]);

    await expect(useCase.execute(command())).rejects.toBe(boom);
    expect(state.runs).toBe(2);
  });

  test("tipos ainda não suportados são recusados antes de abrir qualquer transação", async () => {
    const { state, useCase } = scriptedUnitOfWork([]);

    for (const overrides of [
      { kind: "REFUND", referenceExternalTransactionId: "bet-1" },
      { kind: "ROLLBACK", referenceExternalTransactionId: "bet-1" },
      { kind: "WIN", referenceExternalTransactionId: "bet-1" },
      { kind: "LOSS", referenceExternalTransactionId: "bet-1" },
    ]) {
      await expect(useCase.execute(command(overrides))).rejects.toBeInstanceOf(
        KindNotSupportedYetError,
      );
    }

    expect(state.runs).toBe(0);
  });
});
