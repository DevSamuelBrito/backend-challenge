import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { PROVIDER_IDENTITY } from "../../src/modules/auth/provider-identity.port";
import { CLOCK } from "../../src/shared/application/clock.port";
import { ID_GENERATOR } from "../../src/shared/application/id-generator.port";
import { FixedClock, SequentialIdGenerator } from "../support/doubles";
import { expectInvariants } from "../support/invariants";
import { EMPTY_COUNTS, tableCounts } from "../support/table-counts";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

const request = (amount: string, currency = "BRL") => ({
  playerId: `player-${randomUUID()}`,
  initialBalance: { amount, currency },
});

describe("POST /wallets usa as portas Clock e IdGenerator", () => {
  const FIXED = new Date("2030-05-06T07:08:09.123Z");
  const ids = new SequentialIdGenerator();
  let api: WalletApi;

  beforeAll(async () => {
    api = await startWalletApi({
      providers: [
        { token: CLOCK, value: new FixedClock(FIXED) },
        { token: ID_GENERATOR, value: ids },
      ],
    });
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(async () => {
    await expectInvariants(api.db.client);
  });

  const query = async (sql: string, params: unknown[]) =>
    (await api.db.client.query(sql, params)).rows as Record<string, unknown>[];

  test("toda data gravada vem do Clock e todo id vem do IdGenerator (saldo > 0)", async () => {
    const issuedBefore = ids.issued.length;

    const response = await api.http.post("/wallets", request("100.00"));
    const { id } = response.body as { id: string };

    const [wallet] = await query("select * from wallets where id = $1", [id]);
    const [transaction] = await query("select * from wager_transactions where wallet_id = $1", [
      id,
    ]);
    const [entry] = await query("select * from wallet_ledger_entries where wallet_id = $1", [id]);
    const events = await query(
      "select * from outbox_messages where aggregate_id in ($1, $2) order by seq",
      [id, transaction?.id],
    );

    expect(wallet?.created_at).toEqual(FIXED);
    expect(wallet?.updated_at).toEqual(FIXED);
    expect(transaction?.created_at).toEqual(FIXED);
    expect(transaction?.processed_at).toEqual(FIXED);
    expect(entry?.created_at).toEqual(FIXED);
    expect(events).toHaveLength(2);
    for (const event of events) {
      const payload = event.payload as { occurredAt: string };
      expect(event.occurred_at).toEqual(FIXED);
      expect(event.next_attempt_at).toEqual(FIXED);
      expect(payload.occurredAt).toBe(FIXED.toISOString());
    }

    const issued = ids.issued.slice(issuedBefore);
    const correlationId = (events[0] as { payload: { correlationId: string } }).payload
      .correlationId;
    const used = [
      id,
      transaction?.id,
      entry?.id,
      correlationId,
      ...events.map((event) => event.id),
    ];

    expect(id).toBe(issued[1] as string);
    expect(new Set(used).size).toBe(6);
    expect([...used].sort()).toEqual([...issued].sort());
  });

  test("com saldo zero a wallet também usa Clock e IdGenerator", async () => {
    const issuedBefore = ids.issued.length;

    const response = await api.http.post("/wallets", request("0.00"));
    const { id } = response.body as { id: string };
    const [wallet] = await query("select * from wallets where id = $1", [id]);

    expect(id).toBe(ids.issued[issuedBefore + 1] as string);
    expect(wallet?.created_at).toEqual(FIXED);
    expect(wallet?.updated_at).toEqual(FIXED);
  });
});

describe("AuthGuard no POST/GET /wallets e fora do /health", () => {
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

  test("a porta de identidade pode barrar POST /wallets, e nada é gravado", async () => {
    const response = await api.http.post("/wallets", request("100.00"));

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: "UNAUTHORIZED", message: expect.any(String) });
    expect(await tableCounts(api.db.client)).toEqual(EMPTY_COUNTS);
  });

  test("a porta de identidade também barra GET /wallets/:walletId", async () => {
    const response = await api.http.get(`/wallets/${randomUUID()}`);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("o /health não passa pelo guard: live e ready continuam respondendo", async () => {
    const live = await api.http.get("/health/live");
    const ready = await api.http.get("/health/ready");

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
  });
});
