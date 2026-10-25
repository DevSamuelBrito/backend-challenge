import { describe, expect, test } from "bun:test";
import { runWithContext } from "../../src/shared/application/request-context";
import {
  createPino,
  PinoLoggerService,
} from "../../src/shared/infrastructure/observability/pino-logger";
import { REDACT_CENSOR } from "../../src/shared/infrastructure/observability/redaction";
import { LogCapture } from "../support/observability";

function setup(level: Parameters<typeof createPino>[0] = "debug") {
  const capture = new LogCapture();
  const service = new PinoLoggerService(createPino(level, capture));

  return { capture, service, pino: createPino(level, capture) };
}

describe("redaction do pino (segunda linha de defesa)", () => {
  const sensitive = [
    "money",
    "amount",
    "balance",
    "storedBalance",
    "calculatedBalance",
    "difference",
    "idempotencyKey",
    "body",
    "payload",
    "headers",
    "authorization",
  ];

  test.each(sensitive)("o campo %s no topo vira [REDACTED]", (key) => {
    const { capture, pino } = setup();

    pino.info({ [key]: "123456.78", other: "ok" }, "evento");

    expect(capture.raw[0]).not.toContain("123456.78");
    expect(capture.lines[0]).toMatchObject({ [key]: REDACT_CENSOR, other: "ok" });
  });

  test.each(sensitive)("o campo %s aninhado em um nível também", (key) => {
    const { capture, pino } = setup();

    pino.info({ data: { [key]: { amount: "123456.78" }, walletId: "w" } }, "evento");

    expect(capture.raw[0]).not.toContain("123456.78");
    expect(capture.lines[0]?.data).toMatchObject({ [key]: REDACT_CENSOR, walletId: "w" });
  });

  test("o header Idempotency-Key é coberto", () => {
    const { capture, pino } = setup();

    pino.info({ req: { headers: { "idempotency-key": "chave-secreta-xyz" } } }, "req");

    expect(capture.raw[0]).not.toContain("chave-secreta-xyz");
  });

  test("identificadores e códigos passam intactos", () => {
    const { capture, pino } = setup();

    pino.info({ walletId: "w-1", transactionId: "t-1", kind: "BET", status: "PROCESSED" }, "ok");

    expect(capture.lines[0]).toMatchObject({
      walletId: "w-1",
      transactionId: "t-1",
      kind: "BET",
      status: "PROCESSED",
    });
  });
});

describe("PinoLoggerService", () => {
  test("a linha é JSON com nível textual, horário ISO, serviço e o event como msg", () => {
    const { capture, service } = setup();

    service.log({ event: "wager.processed", kind: "BET" }, "Contexto");

    const line = capture.lines[0] as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "info",
      msg: "wager.processed",
      event: "wager.processed",
      kind: "BET",
      context: "Contexto",
      service: "distributed-wagering-processor",
    });
    expect(new Date(line.time as string).toISOString()).toBe(line.time as string);
  });

  test("os níveis do Nest são traduzidos", () => {
    const { capture, service } = setup("trace");

    service.log("a");
    service.error("b");
    service.warn("c");
    service.debug("d");
    service.verbose("e");
    service.fatal("f");

    expect(capture.lines.map((line) => line.level)).toEqual([
      "info",
      "error",
      "warn",
      "debug",
      "trace",
      "fatal",
    ]);
  });

  test("mensagem de texto do Nest vira msg, com o contexto", () => {
    const { capture, service } = setup();

    service.log("Starting Nest application...", "NestFactory");

    expect(capture.lines[0]).toMatchObject({
      msg: "Starting Nest application...",
      context: "NestFactory",
    });
  });

  test("o nível configurado filtra", () => {
    const { capture, service } = setup("warn");

    service.log({ event: "x" });
    service.warn({ event: "y" });

    expect(capture.lines.map((line) => line.event)).toEqual(["y"]);
  });

  test("o contexto da requisição entra em toda linha, sem passar parâmetros", () => {
    const { capture, service } = setup();

    runWithContext(
      {
        correlationId: "c-1",
        messageId: "m-1",
        transactionId: "t-1",
        walletId: "w-1",
        providerId: "p-1",
      },
      () => service.log({ event: "dentro" }),
    );
    service.log({ event: "fora" });

    expect(capture.lines[0]).toMatchObject({
      correlationId: "c-1",
      messageId: "m-1",
      transactionId: "t-1",
      walletId: "w-1",
      providerId: "p-1",
    });
    expect(capture.lines[1]).not.toHaveProperty("correlationId");
  });

  test("campos explícitos do log sobrepõem o contexto", () => {
    const { capture, service } = setup();

    runWithContext({ correlationId: "do-contexto" }, () =>
      service.log({ event: "x", correlationId: "explicito" }),
    );

    expect(capture.lines[0]?.correlationId).toBe("explicito");
  });

  test("objetos redigidos mesmo quando chegam pelo serviço", () => {
    const { capture, service } = setup();

    service.warn({ event: "x", money: { amount: "123456.78" }, idempotencyKey: "segredo" });

    expect(capture.raw[0]).not.toContain("123456.78");
    expect(capture.raw[0]).not.toContain("segredo");
  });

  test("um Error vira só o nome (a mensagem pode ter dados)", () => {
    const { capture, service } = setup();

    service.error(new Error("valor 123456.78"));

    expect(capture.raw[0]).not.toContain("123456.78");
  });
});
