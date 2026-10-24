import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMigratedDatabase, type TestDatabase } from "../support/database";
import { findInvariantViolations } from "../support/invariants";
import {
  insertRow,
  ledgerRow,
  outboxRow,
  seedTransaction,
  seedWallet,
} from "../support/schema-fixtures";

interface Movement {
  version: number;
  direction: "CREDIT" | "DEBIT";
  amount: string;
  before: string;
  after: string;
  kind?: string;
  status?: string;
  failureCode?: string;
  withEvent?: boolean;
}

describe("helper de invariantes: detecta cada violação e não acusa dados consistentes", () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createMigratedDatabase();
  });

  afterEach(async () => {
    await db.close();
  });

  const openedWallet = async (balance = "100.00") => {
    const wallet = await seedWallet(db.client, { balance, version: 1 });
    await movement(wallet.id, {
      version: 1,
      direction: "CREDIT",
      amount: balance,
      before: "0.00",
      after: balance,
      kind: "OPENING",
    });
    return wallet.id;
  };

  const movement = async (walletId: string, step: Movement) => {
    const transaction = await seedTransaction(db.client, walletId, {
      kind: step.kind ?? "WIN",
      amount: step.amount,
      status: step.status ?? "PROCESSED",
      ...(step.failureCode && { failure_code: step.failureCode }),
    });

    await insertRow(
      db.client,
      "wallet_ledger_entries",
      ledgerRow(walletId, transaction.id, {
        direction: step.direction,
        amount: step.amount,
        balance_before: step.before,
        balance_after: step.after,
        wallet_version: step.version,
      }),
    );

    if (step.withEvent !== false) {
      await insertRow(
        db.client,
        "outbox_messages",
        outboxRow({
          aggregate_id: walletId,
          event_type: "WalletBalanceChanged",
          payload: { data: { transactionId: transaction.id, walletVersion: step.version } },
        }),
      );
    }

    return transaction.id;
  };

  const setWallet = (walletId: string, balance: string, version: number) =>
    db.client.query("update wallets set balance = $2, version = $3 where id = $1", [
      walletId,
      balance,
      version,
    ]);

  const violations = () => findInvariantViolations(db.client);

  test("banco vazio não tem violação", async () => {
    expect(await violations()).toEqual([]);
  });

  test("wallet aberta com saldo, com OPENING, ledger e evento, é consistente", async () => {
    await openedWallet("250.00");

    expect(await violations()).toEqual([]);
  });

  test("wallet aberta com zero, sem nada no ledger, é consistente", async () => {
    await seedWallet(db.client, { balance: "0.00", version: 1 });

    expect(await violations()).toEqual([]);
  });

  test("histórico longo e correto (crédito, débito, crédito) é consistente", async () => {
    const walletId = await openedWallet("100.00");
    await movement(walletId, {
      version: 2,
      direction: "DEBIT",
      amount: "30.00",
      before: "100.00",
      after: "70.00",
      kind: "BET",
    });
    await movement(walletId, {
      version: 3,
      direction: "CREDIT",
      amount: "5.50",
      before: "70.00",
      after: "75.50",
    });
    await setWallet(walletId, "75.50", 3);

    expect(await violations()).toEqual([]);
  });

  test("wallet zerada que depois recebe movimentação começa o ledger na version 2 e é consistente", async () => {
    const wallet = await seedWallet(db.client, { balance: "0.00", version: 1 });
    await movement(wallet.id, {
      version: 2,
      direction: "CREDIT",
      amount: "10.00",
      before: "0.00",
      after: "10.00",
    });
    await setWallet(wallet.id, "10.00", 2);

    expect(await violations()).toEqual([]);
  });

  test("saldo da wallet diferente do ledger é acusado (soma e último balance_after)", async () => {
    const walletId = await openedWallet("100.00");
    await setWallet(walletId, "90.00", 1);

    const found = await violations();

    expect(found).toHaveLength(2);
    expect(found.join("\n")).toContain("difere da soma do ledger 100.00");
    expect(found.join("\n")).toContain("difere do último balance_after 100.00");
  });

  test("version da wallet diferente da do último lançamento é acusada", async () => {
    const walletId = await openedWallet("100.00");
    await setWallet(walletId, "100.00", 4);

    const found = await violations();

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("wallet_version contíguo");
  });

  test("buraco na sequência de versions do ledger é acusado", async () => {
    const walletId = await openedWallet("100.00");
    await movement(walletId, {
      version: 3,
      direction: "CREDIT",
      amount: "10.00",
      before: "100.00",
      after: "110.00",
    });
    await setWallet(walletId, "110.00", 3);

    const found = await violations();

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("wallet_version contíguo");
    expect(found[0]).toContain("2 lançamentos de 1 a 3");
  });

  test("ledger que não começa na version 1 ou 2 é acusado", async () => {
    const wallet = await seedWallet(db.client, { balance: "10.00", version: 3 });
    await movement(wallet.id, {
      version: 3,
      direction: "CREDIT",
      amount: "10.00",
      before: "0.00",
      after: "10.00",
    });

    const found = await violations();

    expect(found.some((line) => line.includes("wallet_version contíguo"))).toBe(true);
  });

  test("wallet com version > 1 e nenhum lançamento é acusada", async () => {
    await seedWallet(db.client, { balance: "0.00", version: 3 });

    const found = await violations();

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("sem nenhum lançamento");
  });

  test("lançamento que não parte do saldo em que o anterior terminou é acusado", async () => {
    const walletId = await openedWallet("100.00");
    await movement(walletId, {
      version: 2,
      direction: "CREDIT",
      amount: "10.00",
      before: "50.00",
      after: "60.00",
    });
    await setWallet(walletId, "60.00", 2);

    const found = await violations();

    expect(found.some((line) => line.includes("parte de 50.00, esperado 100.00"))).toBe(true);
  });

  test("primeiro lançamento (version 1) que não parte de zero é acusado", async () => {
    const wallet = await seedWallet(db.client, { balance: "110.00", version: 1 });
    await movement(wallet.id, {
      version: 1,
      direction: "CREDIT",
      amount: "10.00",
      before: "100.00",
      after: "110.00",
    });

    const found = await violations();

    expect(found.some((line) => line.includes("parte de 100.00, esperado 0.00"))).toBe(true);
  });

  test("transação REJECTED com lançamento é acusada", async () => {
    const walletId = await openedWallet("100.00");
    await movement(walletId, {
      version: 2,
      direction: "DEBIT",
      amount: "10.00",
      before: "100.00",
      after: "90.00",
      kind: "BET",
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
    });
    await setWallet(walletId, "90.00", 2);

    const found = await violations();

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("BET, REJECTED");
  });

  test("transação LOSS com lançamento é acusada", async () => {
    const walletId = await openedWallet("100.00");
    await movement(walletId, {
      version: 2,
      direction: "DEBIT",
      amount: "10.00",
      before: "100.00",
      after: "90.00",
      kind: "LOSS",
    });
    await setWallet(walletId, "90.00", 2);

    const found = await violations();

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("LOSS, PROCESSED");
  });

  test("lançamento sem WalletBalanceChanged na outbox é acusado", async () => {
    const walletId = await openedWallet("100.00");
    await movement(walletId, {
      version: 2,
      direction: "CREDIT",
      amount: "10.00",
      before: "100.00",
      after: "110.00",
      withEvent: false,
    });
    await setWallet(walletId, "110.00", 2);

    const found = await violations();

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("sem WalletBalanceChanged na outbox");
  });

  test("evento de outro tipo, de outra wallet ou de outra version não conta como WalletBalanceChanged", async () => {
    const walletId = await openedWallet("100.00");
    const other = await openedWallet("1.00");
    const transactionId = await movement(walletId, {
      version: 2,
      direction: "CREDIT",
      amount: "10.00",
      before: "100.00",
      after: "110.00",
      withEvent: false,
    });
    await setWallet(walletId, "110.00", 2);

    const wrongEvents = [
      { aggregate_id: walletId, event_type: "WagerTransactionProcessed", version: 2 },
      { aggregate_id: other, event_type: "WalletBalanceChanged", version: 2 },
      { aggregate_id: walletId, event_type: "WalletBalanceChanged", version: 9 },
    ];

    for (const event of wrongEvents) {
      await insertRow(
        db.client,
        "outbox_messages",
        outboxRow({
          aggregate_id: event.aggregate_id,
          event_type: event.event_type,
          payload: { data: { transactionId, walletVersion: event.version } },
        }),
      );
    }

    const found = await violations();

    expect(found).toHaveLength(1);
    expect(found[0]).toContain("sem WalletBalanceChanged na outbox");
  });
});
