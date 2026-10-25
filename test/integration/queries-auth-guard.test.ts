import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { PROVIDER_IDENTITY } from "../../src/modules/auth/provider-identity.port";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

describe("AuthGuard nos endpoints de consulta e reconciliação", () => {
  let api: WalletApi;

  beforeAll(async () => {
    api = await startWalletApi({
      providers: [
        {
          token: PROVIDER_IDENTITY,
          value: {
            identify: async () => {
              throw new UnauthorizedException();
            },
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await api.close();
  });

  test.each([
    ["GET", () => `/wallets/${randomUUID()}/ledger`],
    ["GET", () => `/wagering/transactions/${randomUUID()}`],
    ["GET", () => "/providers/provider-a/wagering/transactions/ext-1"],
    ["POST", () => `/wallets/${randomUUID()}/reconciliation`],
  ])("%s %p é barrado pela porta de identidade com o corpo padrão", async (method, path) => {
    const response =
      method === "GET" ? await api.http.get(path()) : await api.http.post(path(), {});

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: "UNAUTHORIZED", message: expect.any(String) });
  });
});
