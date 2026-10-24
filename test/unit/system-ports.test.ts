import { describe, expect, test } from "bun:test";
import { AnonymousProviderIdentity } from "../../src/modules/auth/anonymous-provider-identity";
import { AuthGuard } from "../../src/modules/auth/auth.guard";
import type { ProviderIdentityPort } from "../../src/modules/auth/provider-identity.port";
import { SystemClock } from "../../src/shared/infrastructure/system/system-clock";
import { UuidV7Generator } from "../../src/shared/infrastructure/system/uuid-v7-generator";

describe("UuidV7Generator", () => {
  const generator = new UuidV7Generator();

  test("gera UUIDs versão 7 no formato canônico", () => {
    for (let index = 0; index < 100; index++) {
      expect(generator.next()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  test("nunca repete e mantém a ordem de geração", () => {
    const ids = Array.from({ length: 2000 }, () => generator.next());

    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe("SystemClock", () => {
  test("devolve a hora atual a cada chamada", () => {
    const before = Date.now();
    const now = new SystemClock().now();
    const after = Date.now();

    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("AuthGuard (D9: no-op)", () => {
  const context = (request: unknown) =>
    ({ switchToHttp: () => ({ getRequest: () => request }) }) as never;

  test("com a identidade anônima deixa passar", async () => {
    const guard = new AuthGuard(new AnonymousProviderIdentity());

    expect(await guard.canActivate(context({}))).toBe(true);
  });

  test("consulta a porta com a requisição recebida", async () => {
    const seen: unknown[] = [];
    const port: ProviderIdentityPort = {
      identify: async (request) => {
        seen.push(request);
        return { providerId: "provider-a" };
      },
    };
    const request = { headers: {} };

    await new AuthGuard(port).canActivate(context(request));

    expect(seen).toEqual([request]);
  });

  test("se a porta rejeitar a identidade, a requisição é barrada", async () => {
    const denied = new Error("sem credencial");
    const port: ProviderIdentityPort = {
      identify: async () => {
        throw denied;
      },
    };

    await expect(new AuthGuard(port).canActivate(context({}))).rejects.toBe(denied);
  });

  test("a identidade anônima devolve um provedor fixo", async () => {
    expect(await new AnonymousProviderIdentity().identify()).toEqual({ providerId: "anonymous" });
  });
});
