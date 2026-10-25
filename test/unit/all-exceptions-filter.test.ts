import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  type ArgumentsHost,
  BadRequestException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  InsufficientFundsError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../src/modules/wallet/domain/wallet-errors";
import { InvalidRequestError } from "../../src/shared/application/invalid-request-error";
import { LockTimeoutError } from "../../src/shared/application/persistence-errors";
import { InvalidMoneyError, MoneyOutOfRangeError } from "../../src/shared/domain/money";
import { AllExceptionsFilter } from "../../src/shared/infrastructure/http/all-exceptions.filter";

interface Captured {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

function handle(exception: unknown): Captured {
  const captured: Captured = { status: 0, body: undefined, headers: {} };
  const response = {
    status(code: number) {
      captured.status = code;
      return response;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    json(body: unknown) {
      captured.body = body;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);

  return captured;
}

describe("AllExceptionsFilter", () => {
  let logged: unknown[];

  beforeEach(() => {
    logged = [];
    spyOn(Logger.prototype, "error").mockImplementation((message: unknown) => {
      logged.push(message);
    });
  });

  afterEach(() => {
    (Logger.prototype.error as unknown as { mockRestore(): void }).mockRestore();
  });

  test("wallet duplicada vira 409 com code estável", () => {
    const result = handle(new WalletAlreadyExistsError("player-1", "BRL"));

    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      code: "WALLET_ALREADY_EXISTS",
      message: "Já existe uma wallet em BRL para o jogador player-1",
    });
  });

  test("não encontrado vira 404", () => {
    const result = handle(new WalletNotFoundError("w-1"));

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ code: "WALLET_NOT_FOUND", message: "Wallet w-1 não existe" });
  });

  test("Money inválido, fora do limite e pedido inválido viram 400", () => {
    expect(handle(new InvalidMoneyError("Valor monetário inválido: 1.0"))).toMatchObject({
      status: 400,
      body: { code: "INVALID_MONEY" },
    });
    expect(handle(new MoneyOutOfRangeError())).toMatchObject({
      status: 400,
      body: { code: "MONEY_OUT_OF_RANGE" },
    });
    expect(handle(new InvalidRequestError("playerId deve ser uma string não vazia"))).toMatchObject(
      {
        status: 400,
        body: { code: "INVALID_REQUEST", message: "playerId deve ser uma string não vazia" },
      },
    );
  });

  test("qualquer outro DomainError vira 400 com o seu code", () => {
    expect(handle(new InsufficientFundsError("w-1"))).toMatchObject({
      status: 400,
      body: { code: "INSUFFICIENT_FUNDS" },
    });
  });

  test("lock timeout vira 503 com Retry-After", () => {
    const result = handle(new LockTimeoutError(5000));

    expect(result.status).toBe(503);
    expect(result.headers["Retry-After"]).toBe("1");
    expect(result.body).toMatchObject({ code: "LOCK_TIMEOUT" });
  });

  test("HttpException do Nest ganha o corpo padrão { code, message }", () => {
    expect(handle(new BadRequestException("JSON malformado"))).toEqual({
      status: 400,
      body: { code: "INVALID_REQUEST", message: "JSON malformado" },
      headers: {},
    });
    expect(handle(new NotFoundException("Cannot GET /x"))).toMatchObject({
      status: 404,
      body: { code: "NOT_FOUND" },
    });
    expect(handle(new UnauthorizedException())).toMatchObject({
      status: 401,
      body: { code: "UNAUTHORIZED" },
    });
  });

  test("HttpException com corpo próprio (como o /health/ready) passa como está", () => {
    const body = { status: "unavailable", checks: { postgres: "down" } };

    expect(handle(new ServiceUnavailableException(body))).toMatchObject({ status: 503, body });
  });

  test("erros de cliente do parser HTTP (status 4xx) viram o corpo padrão", () => {
    expect(handle(Object.assign(new Error("Unexpected token"), { status: 400 }))).toMatchObject({
      status: 400,
      body: { code: "INVALID_REQUEST", message: "Unexpected token" },
    });
    expect(handle(Object.assign(new Error("too large"), { statusCode: 413 }))).toMatchObject({
      status: 413,
      body: { code: "PAYLOAD_TOO_LARGE" },
    });
    expect(handle(Object.assign(new Error("teapot"), { status: 418 }))).toMatchObject({
      status: 418,
      body: { code: "HTTP_418" },
    });
  });

  test("falha inesperada vira 500 genérico e não vaza o detalhe", () => {
    const secret = new Error("connection refused: postgres://wagering:senha-secreta@db:5432");
    const result = handle(secret);

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ code: "INTERNAL_ERROR", message: "Erro interno do servidor" });
    expect(JSON.stringify(result.body)).not.toContain("senha-secreta");
  });

  test("falha inesperada é registrada em log só com nome, código e frames, nunca com a mensagem", () => {
    handle(Object.assign(new Error("detalhe-só-para-o-log"), { code: "23505" }));

    expect(logged[0]).toMatchObject({
      event: "http.unhandled_error",
      errorName: "Error",
      errorCode: "23505",
    });
    expect(JSON.stringify(logged[0])).not.toContain("detalhe-só-para-o-log");
  });

  test("erros 5xx do parser e valores que não são Error também viram 500 genérico", () => {
    for (const thrown of ["texto solto", 42, null, undefined, { status: 500, message: "x" }]) {
      expect(handle(thrown)).toMatchObject({
        status: 500,
        body: { code: "INTERNAL_ERROR", message: "Erro interno do servidor" },
      });
    }
  });

  test("erros de domínio e 4xx não são logados como falha", () => {
    handle(new WalletAlreadyExistsError("p", "BRL"));
    handle(new BadRequestException("x"));

    expect(logged).toEqual([]);
  });
});
