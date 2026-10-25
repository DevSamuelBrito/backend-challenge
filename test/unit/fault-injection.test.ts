import { describe, expect, spyOn, test } from "bun:test";
import { Logger } from "@nestjs/common";
import { loadConfig } from "../../src/config/env";
import { FAULT_POINTS } from "../../src/shared/application/fault-injector.port";
import { ProcessKillFaultInjector } from "../../src/shared/infrastructure/system/process-kill-fault-injector";

describe("config: injeção de falha", () => {
  test("desligada por padrão", () => {
    expect(loadConfig({}).faultInjection).toEqual({ point: undefined });
    expect(loadConfig({ ENABLE_FAULT_INJECTION: "false" }).faultInjection).toEqual({
      point: undefined,
    });
  });

  test.each(FAULT_POINTS)("liga no ponto %s", (point) => {
    expect(
      loadConfig({ ENABLE_FAULT_INJECTION: "true", FAULT_POINT: point }).faultInjection,
    ).toEqual({ point });
  });

  test("recusa FAULT_POINT sem ENABLE_FAULT_INJECTION", () => {
    expect(() => loadConfig({ FAULT_POINT: "consumer.after_commit_before_ack" })).toThrow(
      "FAULT_POINT exige ENABLE_FAULT_INJECTION=true",
    );
    expect(() =>
      loadConfig({
        ENABLE_FAULT_INJECTION: "false",
        FAULT_POINT: "consumer.after_commit_before_ack",
      }),
    ).toThrow("FAULT_POINT exige ENABLE_FAULT_INJECTION=true");
  });

  test("ligada exige um ponto conhecido", () => {
    expect(() => loadConfig({ ENABLE_FAULT_INJECTION: "true" })).toThrow("FAULT_POINT inválido");
    expect(() => loadConfig({ ENABLE_FAULT_INJECTION: "true", FAULT_POINT: "nao.existe" })).toThrow(
      "FAULT_POINT inválido: nao.existe",
    );
  });

  test("a flag só aceita true ou false", () => {
    expect(() => loadConfig({ ENABLE_FAULT_INJECTION: "yes" })).toThrow(
      "ENABLE_FAULT_INJECTION inválido",
    );
  });
});

describe("ProcessKillFaultInjector", () => {
  spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

  test("ignora os pontos que não são o configurado", () => {
    let kills = 0;
    const injector = new ProcessKillFaultInjector("consumer.after_commit_before_ack", () => {
      kills++;
    });

    injector.check("outbox.after_send_before_mark");

    expect(kills).toBe(0);
  });

  test("no ponto configurado mata o processo e nunca devolve o controle", async () => {
    let kills = 0;
    const injector = new ProcessKillFaultInjector("outbox.after_send_before_mark", () => {
      kills++;
    });

    const outcome = await Promise.race([
      Promise.resolve(injector.check("outbox.after_send_before_mark")).then(() => "voltou"),
      new Promise((resolve) => setTimeout(() => resolve("travado"), 50)),
    ]);

    expect(kills).toBe(1);
    expect(outcome).toBe("travado");
  });

  test("a morte é real: sem handler de exit, sem SIGTERM e sem código depois do ponto", async () => {
    const child = Bun.spawn([process.execPath, "test/support/fixtures/self-kill.ts"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = stdout + stderr;

    expect(exitCode).not.toBe(0);
    expect(output).toContain("passou pelo ponto que não é o configurado");
    expect(output).toContain("fault.crash");
    expect(output).not.toContain("handler de");
    expect(output).not.toContain("não deveria aparecer");
  });
});
