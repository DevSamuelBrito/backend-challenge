import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { UnauthorizedException } from "@nestjs/common";
import { PROVIDER_IDENTITY } from "../../src/modules/auth/provider-identity.port";
import { CLOCK } from "../../src/shared/application/clock.port";
import { ID_GENERATOR } from "../../src/shared/application/id-generator.port";
import { FixedClock, SequentialIdGenerator } from "../support/doubles";
import { expectInvariants } from "../support/invariants";
import { EMPTY_COUNTS, tableCounts } from "../support/table-counts";
import { keyFor, openWallet, submit, wagerPayload } from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

describe("POST /wagering/transactions usa as portas Clock e IdGenerator", () => {
  const FIXED = new Date("2031-02-03T04:05:06.789Z");
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

  test("BET aceita: toda data vem do Clock e todo id vem do IdGenerator", async () => {
    const wallet = await openWallet(api.http, "100.00");
    const issuedBefore = ids.issued.length;
    const payload = wagerPayload(wallet);

    const response = await submit(api.http, payload, keyFor(payload));
    const { transactionId } = response.body as { transactionId: string };

    const [transaction] = await query("select * from wager_transactions where id = $1", [
      transactionId,
    ]);
    const [entry] = await query("select * from wallet_ledger_entries where transaction_id = $1", [
      transactionId,
    ]);
    const events = await query(
      "select * from outbox_messages where payload -> 'data' ->> 'transactionId' = $1 order by seq",
      [transactionId],
    );
    const [walletRow] = await query("select * from wallets where id = $1", [wallet.id]);

    expect(transaction?.created_at).toEqual(FIXED);
    expect(transaction?.processed_at).toEqual(FIXED);
    expect(entry?.created_at).toEqual(FIXED);
    expect(walletRow?.updated_at).toEqual(FIXED);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.occurred_at).toEqual(FIXED);
      expect(event.next_attempt_at).toEqual(FIXED);
    }

    const issued = ids.issued.slice(issuedBefore);
    const correlationId = (events[0] as { payload: { correlationId: string } }).payload
      .correlationId;
    const used = [transactionId, entry?.id, correlationId, ...events.map((event) => event.id)];

    expect(new Set(used).size).toBe(5);
    expect([...used].sort()).toEqual([...issued].sort());
  });

  test("BET rejeitada também usa Clock e IdGenerator", async () => {
    const wallet = await openWallet(api.http, "10.00");
    const issuedBefore = ids.issued.length;
    const payload = wagerPayload(wallet, { money: { amount: "50.00", currency: "BRL" } });

    const response = await submit(api.http, payload, keyFor(payload));
    const { transactionId } = response.body as { transactionId: string };
    const [transaction] = await query("select * from wager_transactions where id = $1", [
      transactionId,
    ]);

    expect(response.status).toBe(422);
    expect(transaction?.created_at).toEqual(FIXED);
    expect(transaction?.processed_at).toEqual(FIXED);
    expect(ids.issued.slice(issuedBefore)).toContain(transactionId);
  });
});

describe("AuthGuard no POST /wagering/transactions", () => {
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

  test("a porta de identidade pode barrar o endpoint, e nada é gravado", async () => {
    const payload = wagerPayload({
      id: "0192f291-27dd-7d3f-8071-5f8685deef37",
      playerId: "p",
      currency: "BRL",
    });

    const response = await submit(api.http, payload, "k-auth");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: "UNAUTHORIZED", message: expect.any(String) });
    expect(await tableCounts(api.db.client)).toEqual(EMPTY_COUNTS);
  });
});
