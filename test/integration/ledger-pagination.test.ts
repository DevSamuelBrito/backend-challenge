import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { expectInvariants } from "../support/invariants";
import {
  type OpenedWallet,
  openWallet,
  submitWithDefaultKey,
  wagerPayload,
} from "../support/wagering-api";
import { startWalletApi, type WalletApi } from "../support/wallet-api";

const money = (amount: string) => ({ amount, currency: "BRL" });

interface LedgerItem {
  id: string;
  transactionId: string;
  direction: string;
  money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  walletVersion: number;
  createdAt: string;
}

interface LedgerPage {
  items: LedgerItem[];
  nextCursor: string | null;
}

describe("GET /wallets/:walletId/ledger", () => {
  let api: WalletApi;

  beforeAll(async () => {
    api = await startWalletApi();
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(async () => {
    await expectInvariants(api.db.client);
  });

  const page = async (walletId: string, query = ""): Promise<{ status: number; body: unknown }> => {
    const result = await api.http.get(`/wallets/${walletId}/ledger${query}`);

    return { status: result.status, body: result.body };
  };

  const bet = async (wallet: OpenedWallet, amount = "1.00") => {
    const result = await submitWithDefaultKey(
      api.http,
      wagerPayload(wallet, { money: money(amount) }),
    );
    expect(result.status).toBe(200);
  };

  const walletWithBets = async (bets: number) => {
    const wallet = await openWallet(api.http, "1000.00");
    for (let index = 0; index < bets; index += 1) {
      await bet(wallet);
    }

    return wallet;
  };

  const walkAll = async (walletId: string, limit: number): Promise<LedgerPage[]> => {
    const pages: LedgerPage[] = [];
    let cursor: string | null = null;

    do {
      const query: string = `?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
      const { status, body } = await page(walletId, query);
      expect(status).toBe(200);
      pages.push(body as LedgerPage);
      cursor = (body as LedgerPage).nextCursor;
    } while (cursor);

    return pages;
  };

  test("percorre todas as páginas em ordem crescente, sem repetir nem pular, e a última tem nextCursor null", async () => {
    const wallet = await walletWithBets(7);

    const pages = await walkAll(wallet.id, 3);

    expect(pages.map((p) => p.items.length)).toEqual([3, 3, 2]);
    expect(pages.map((p) => p.nextCursor === null)).toEqual([false, false, true]);
    const items = pages.flatMap((p) => p.items);
    expect(items.map((item) => item.walletVersion)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(items.map((item) => item.id)).size).toBe(8);
  });

  test("cada item tem o formato do contrato, com dinheiro em string", async () => {
    const wallet = await walletWithBets(1);

    const { body } = await page(wallet.id);

    const [opening, betEntry] = (body as LedgerPage).items as [LedgerItem, LedgerItem];
    expect(Object.keys(opening).sort()).toEqual(
      [
        "balanceAfter",
        "balanceBefore",
        "createdAt",
        "direction",
        "id",
        "money",
        "transactionId",
        "walletVersion",
      ].sort(),
    );
    expect(opening).toMatchObject({
      direction: "CREDIT",
      money: money("1000.00"),
      balanceBefore: money("0.00"),
      balanceAfter: money("1000.00"),
      walletVersion: 1,
    });
    expect(betEntry).toMatchObject({
      direction: "DEBIT",
      money: money("1.00"),
      balanceBefore: money("1000.00"),
      balanceAfter: money("999.00"),
      walletVersion: 2,
    });
    expect(new Date(betEntry.createdAt).toISOString()).toBe(betEntry.createdAt);
    expect(typeof betEntry.money.amount).toBe("string");
  });

  test("limit padrão é 50 e limit 200 é aceito", async () => {
    const wallet = await walletWithBets(54);

    const byDefault = (await page(wallet.id)).body as LedgerPage;
    const maximum = (await page(wallet.id, "?limit=200")).body as LedgerPage;

    expect(byDefault.items).toHaveLength(50);
    expect(byDefault.nextCursor).not.toBeNull();
    expect(maximum.items).toHaveLength(55);
    expect(maximum.nextCursor).toBeNull();
  });

  test("limit igual ao total devolve tudo com nextCursor null; um a menos devolve cursor", async () => {
    const wallet = await walletWithBets(4);

    const exact = (await page(wallet.id, "?limit=5")).body as LedgerPage;
    const oneShort = (await page(wallet.id, "?limit=4")).body as LedgerPage;
    const rest = (await page(wallet.id, `?limit=4&cursor=${oneShort.nextCursor}`))
      .body as LedgerPage;

    expect(exact.items).toHaveLength(5);
    expect(exact.nextCursor).toBeNull();
    expect(oneShort.items).toHaveLength(4);
    expect(oneShort.nextCursor).not.toBeNull();
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
  });

  test("o cursor é opaco: não contém o seq em texto puro nem é o base64 do seq", async () => {
    const wallet = await walletWithBets(3);
    const { body } = await page(wallet.id, "?limit=2");
    const { nextCursor, items } = body as LedgerPage;
    const lastItem = items.at(-1) as LedgerItem;
    const { rows } = await api.db.client.query(
      "select seq::text as seq from wallet_ledger_entries where id = $1",
      [lastItem.id],
    );
    const seq = rows[0].seq as string;

    expect(nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(nextCursor).not.toContain(seq);
    expect(nextCursor).not.toBe(Buffer.from(seq).toString("base64url"));
  });

  test("o cursor continua exatamente depois do último item visto", async () => {
    const wallet = await walletWithBets(5);
    const first = (await page(wallet.id, "?limit=2")).body as LedgerPage;
    const second = (await page(wallet.id, `?limit=2&cursor=${first.nextCursor}`))
      .body as LedgerPage;

    expect(first.items.map((i) => i.walletVersion)).toEqual([1, 2]);
    expect(second.items.map((i) => i.walletVersion)).toEqual([3, 4]);
  });

  test("wallet sem lançamentos: items vazio e nextCursor null", async () => {
    const wallet = await openWallet(api.http, "0.00");

    const { status, body } = await page(wallet.id);

    expect(status).toBe(200);
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  test("um cursor de outra wallet nunca mostra lançamentos dela", async () => {
    const mine = await walletWithBets(2);
    const other = await walletWithBets(2);
    const otherPage = (await page(other.id, "?limit=1")).body as LedgerPage;

    const { body } = await page(mine.id, `?cursor=${otherPage.nextCursor}`);

    const walletIds = new Set(
      ((body as LedgerPage).items as LedgerItem[]).map((item) => item.transactionId),
    );
    const { rows } = await api.db.client.query(
      "select transaction_id from wallet_ledger_entries where wallet_id = $1",
      [mine.id],
    );
    const mineTransactions = new Set(rows.map((row) => row.transaction_id as string));
    expect([...walletIds].every((id) => mineTransactions.has(id))).toBe(true);
  });

  test.each([
    ["limit=0"],
    ["limit=-1"],
    ["limit=201"],
    ["limit=1.5"],
    ["limit=abc"],
    ["limit="],
    ["limit=1e2"],
    ["limit=1&limit=2"],
    ["cursor="],
    ["cursor=!!!"],
    ["cursor=bGl2cm8"],
    ["cursor=bDE6YWJj"],
    ["cursor=bDE6MA"],
    ["cursor=bDE6LTU"],
    ["cursor=a&cursor=b"],
  ])("recusa a query %s com 400", async (query) => {
    const wallet = await walletWithBets(1);

    const { status, body } = await page(wallet.id, `?${query}`);

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "INVALID_REQUEST" });
    expect(typeof (body as { message: string }).message).toBe("string");
  });

  test("wallet inexistente é 404 e walletId malformado é 400", async () => {
    const missing = await page(randomUUID());
    const malformed = await page("nao-e-uuid");

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "WALLET_NOT_FOUND" });
    expect(malformed.status).toBe(400);
  });

  test("a validação vem antes do 404: query inválida numa wallet inexistente é 400", async () => {
    const { status } = await page(randomUUID(), "?limit=0");

    expect(status).toBe(400);
  });
});

describe("GET /wallets/:walletId/ledger: estabilidade com escritas em paralelo", () => {
  let api: WalletApi;

  beforeAll(async () => {
    api = await startWalletApi();
  });

  afterAll(async () => {
    await api.close();
  });

  afterEach(async () => {
    await expectInvariants(api.db.client);
  });

  test("paginar enquanto BETs concorrentes entram: nenhum item se repete e nenhum existente é pulado", async () => {
    const wallet = await openWallet(api.http, "10000.00");
    for (let index = 0; index < 12; index += 1) {
      await submitWithDefaultKey(api.http, wagerPayload(wallet, { money: money("1.00") }));
    }
    const { rows: before } = await api.db.client.query(
      "select id from wallet_ledger_entries where wallet_id = $1",
      [wallet.id],
    );
    const initialIds = new Set(before.map((row) => row.id as string));

    const writer = (async () => {
      for (let round = 0; round < 15; round += 1) {
        await Promise.all(
          Array.from({ length: 4 }, () =>
            submitWithDefaultKey(api.http, wagerPayload(wallet, { money: money("1.00") })),
          ),
        );
      }
    })();

    const seen: LedgerItem[] = [];
    let cursor: string | null = null;

    do {
      const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const result = await api.http.get(`/wallets/${wallet.id}/ledger${query}`);
      expect(result.status).toBe(200);
      const body = result.body as LedgerPage;
      seen.push(...body.items);
      cursor = body.nextCursor;
      await new Promise((resolve) => setTimeout(resolve, 15));
    } while (cursor);
    await writer;

    const ids = seen.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(seen.map((item) => item.walletVersion)).toEqual(
      Array.from({ length: seen.length }, (_, index) => index + 1),
    );
    for (const id of initialIds) {
      expect(ids).toContain(id);
    }
    const { rows: all } = await api.db.client.query(
      "select id from wallet_ledger_entries where wallet_id = $1 order by seq",
      [wallet.id],
    );
    expect(ids).toEqual(all.slice(0, ids.length).map((row) => row.id as string));
    expect(ids.length).toBeGreaterThanOrEqual(initialIds.size);
    expect(all).toHaveLength(1 + 12 + 60);
  });
});
