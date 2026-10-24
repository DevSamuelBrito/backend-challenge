import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import {
  createMigratedDatabase,
  expectDatabaseError,
  SQLSTATE,
  type TestDatabase,
} from "../support/database";
import { insertRow, seedTransaction, seedWallet, transactionRow } from "../support/schema-fixtures";

const MAX_AMOUNT = "999999999999999999.99";
const ABOVE_MAX_AMOUNT = "1000000000000000000.00";
const TERMINAL_STATUSES = ["PROCESSED", "REJECTED", "FAILED"];
const ALL_STATUSES = ["PENDING", "PENDING_REFERENCE", ...TERMINAL_STATUSES];

function statusRow(status: string) {
  const failureCode =
    status === "REJECTED" ? "INSUFFICIENT_FUNDS" : status === "FAILED" ? "PROCESSING_FAILED" : null;

  return { status, failure_code: failureCode };
}

describe("schema: wager_transactions", () => {
  let db: TestDatabase;
  let wallet: { id: string };
  let otherWallet: { id: string };

  const seed = (overrides = {}) => seedTransaction(db.client, wallet.id, overrides);

  const insert = (overrides = {}) =>
    insertRow(db.client, "wager_transactions", transactionRow(wallet.id, overrides));

  beforeAll(async () => {
    db = await createMigratedDatabase();
    wallet = await seedWallet(db.client);
    otherWallet = await seedWallet(db.client);
  });

  afterAll(async () => {
    await db.close();
  });

  describe("domínio dos valores", () => {
    test("aceita uma transação válida", async () => {
      const row = await insert();

      expect(row.status).toBe("PENDING");
      expect(row.reference_attempts).toBe(0);
      expect(row.amount).toBe("25.00");
    });

    test.each([["DEPOSIT"], ["bet"], [""]])("rejeita kind %p", async (kind) => {
      await expectDatabaseError(insert({ kind }), {
        code: SQLSTATE.checkViolation,
        constraint: "wager_transactions_kind_valid",
      });
    });

    test.each([["OPENING"], ["BET"], ["WIN"], ["LOSS"]])(
      "aceita kind %s sem referência",
      async (kind) => {
        await expect(insert({ kind })).resolves.toHaveProperty("id");
      },
    );

    test.each([["DONE"], ["processed"], [""]])("rejeita status %p", async (status) => {
      await expectDatabaseError(insert({ status }), {
        code: SQLSTATE.checkViolation,
        constraint: "wager_transactions_status_valid",
      });
    });

    test.each([["0.00"], ["-1.00"]])("rejeita valor %s (D5: zero é rejeitado)", async (amount) => {
      await expectDatabaseError(insert({ amount }), {
        code: SQLSTATE.checkViolation,
        constraint: "wager_transactions_amount_positive",
      });
    });

    test("rejeita moeda fora do formato ISO-4217", async () => {
      await expectDatabaseError(insert({ currency: "brl" }), {
        code: SQLSTATE.checkViolation,
        constraint: "wager_transactions_currency_format",
      });
    });

    test("a faixa de valor é numeric(20,2): aceita o limite do Money e recusa um centavo acima", async () => {
      const row = await insert({ amount: MAX_AMOUNT });
      expect(row.amount).toBe(MAX_AMOUNT);

      await expectDatabaseError(insert({ amount: ABOVE_MAX_AMOUNT }), {
        code: SQLSTATE.numericOutOfRange,
      });
    });

    test.each([["REFUND"], ["ROLLBACK"]])(
      "%s sem reference_external_transaction_id é recusada",
      async (kind) => {
        await expectDatabaseError(insert({ kind }), {
          code: SQLSTATE.checkViolation,
          constraint: "wager_transactions_reversal_requires_reference",
        });
      },
    );

    test.each([["REFUND"], ["ROLLBACK"]])("%s com referência é aceita", async (kind) => {
      await expect(
        insert({ kind, reference_external_transaction_id: "ext-original" }),
      ).resolves.toHaveProperty("id");
    });

    test("REJECTED exige failure_code", async () => {
      await expectDatabaseError(insert({ status: "REJECTED" }), {
        code: SQLSTATE.checkViolation,
        constraint: "wager_transactions_rejected_requires_failure_code",
      });
      await expect(
        insert({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" }),
      ).resolves.toHaveProperty("id");
    });

    test("o saldo observado nunca é negativo", async () => {
      await expectDatabaseError(insert({ balance_after_amount: "-0.01" }), {
        code: SQLSTATE.checkViolation,
        constraint: "wager_transactions_balance_after_non_negative",
      });
      await expect(insert({ balance_after_amount: "0.00" })).resolves.toHaveProperty("id");
    });

    test("o contador de tentativas nunca é negativo", async () => {
      await expectDatabaseError(insert({ reference_attempts: -1 }), {
        code: SQLSTATE.checkViolation,
        constraint: "wager_transactions_reference_attempts_non_negative",
      });
    });

    test("aceita rejeições por divergência de player e de moeda com a wallet (P2 e P3 são auditáveis)", async () => {
      const mismatched = await insert({
        player_id: "player-de-outra-pessoa",
        currency: "USD",
        ...statusRow("REJECTED"),
      });

      expect(mismatched.status).toBe("REJECTED");
    });
  });

  describe("integridade referencial", () => {
    test("rejeita wallet inexistente", async () => {
      await expectDatabaseError(insert({ wallet_id: randomUUID() }), {
        code: SQLSTATE.foreignKeyViolation,
        constraint: "wager_transactions_wallet_id_fkey",
      });
    });

    test("rejeita reference_transaction_id inexistente", async () => {
      await expectDatabaseError(insert({ reference_transaction_id: randomUUID() }), {
        code: SQLSTATE.foreignKeyViolation,
        constraint: "wager_transactions_reference_transaction_id_fkey",
      });
    });
  });

  describe("idempotência persistente (D3)", () => {
    test("rejeita a mesma idempotency_key duas vezes", async () => {
      const key = `key-${randomUUID()}`;
      await insert({ idempotency_key: key });

      await expectDatabaseError(insert({ idempotency_key: key }), {
        code: SQLSTATE.uniqueViolation,
        constraint: "wager_transactions_idempotency_key_key",
      });
    });

    test("a idempotency_key é global: conflita mesmo com outro provider e outro id externo", async () => {
      const key = `key-${randomUUID()}`;
      await insert({ idempotency_key: key });

      await expectDatabaseError(
        insert({ idempotency_key: key, provider_id: "provider-b", external_transaction_id: "x" }),
        { code: SQLSTATE.uniqueViolation, constraint: "wager_transactions_idempotency_key_key" },
      );
    });

    test("rejeita o mesmo (provider_id, external_transaction_id) duas vezes, mesmo com outra key", async () => {
      const externalId = `ext-${randomUUID()}`;
      await insert({ external_transaction_id: externalId });

      await expectDatabaseError(insert({ external_transaction_id: externalId }), {
        code: SQLSTATE.uniqueViolation,
        constraint: "wager_transactions_provider_external_key",
      });
    });

    test("o mesmo id externo em outro provider é outra transação", async () => {
      const externalId = `ext-${randomUUID()}`;
      await insert({ external_transaction_id: externalId, provider_id: "provider-a" });

      await expect(
        insert({ external_transaction_id: externalId, provider_id: "provider-b" }),
      ).resolves.toHaveProperty("id");
    });

    test("50 inserções simultâneas da mesma transação: exatamente uma vence", async () => {
      const clients = await Promise.all(Array.from({ length: 50 }, () => db.connect()));
      const key = `key-${randomUUID()}`;
      const externalId = `ext-${randomUUID()}`;

      const attempts = Array.from({ length: 50 }, (_, index) =>
        insertRow(
          clients[index] as Client,
          "wager_transactions",
          transactionRow(wallet.id, { idempotency_key: key, external_transaction_id: externalId }),
        ),
      );
      const results = await Promise.allSettled(attempts);

      const winners = results.filter((result) => result.status === "fulfilled");
      const losers = results.filter((result) => result.status === "rejected");

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(49);
      for (const loser of losers) {
        expect((loser as PromiseRejectedResult).reason.code).toBe(SQLSTATE.uniqueViolation);
      }
    });
  });

  describe("reversão única (D4): índice único parcial", () => {
    async function processedBet() {
      const bet = await seed(statusRow("PROCESSED"));
      return {
        ...bet,
        reversal: (kind: string, status = "PROCESSED", extra = {}) =>
          insert({
            kind,
            reference_external_transaction_id: bet.externalId,
            reference_transaction_id: bet.id,
            ...statusRow(status),
            ...extra,
          }),
      };
    }

    test("um REFUND processado reverte a aposta; um segundo REFUND é recusado", async () => {
      const bet = await processedBet();
      await bet.reversal("REFUND");

      await expectDatabaseError(bet.reversal("REFUND"), {
        code: SQLSTATE.uniqueViolation,
        constraint: "wager_transactions_single_reversal_idx",
      });
    });

    test("um ROLLBACK depois de um REFUND da mesma referência também é recusado (qualquer tipo)", async () => {
      const bet = await processedBet();
      await bet.reversal("REFUND");

      await expectDatabaseError(bet.reversal("ROLLBACK"), {
        code: SQLSTATE.uniqueViolation,
        constraint: "wager_transactions_single_reversal_idx",
      });
    });

    test("e na ordem inversa: ROLLBACK primeiro, REFUND depois", async () => {
      const bet = await processedBet();
      await bet.reversal("ROLLBACK");

      await expectDatabaseError(bet.reversal("REFUND"), {
        code: SQLSTATE.uniqueViolation,
        constraint: "wager_transactions_single_reversal_idx",
      });
    });

    test("reversões não processadas não contam: PENDING_REFERENCE e REJECTED coexistem", async () => {
      const bet = await processedBet();
      await bet.reversal("REFUND");

      await expect(bet.reversal("REFUND", "PENDING_REFERENCE")).resolves.toHaveProperty("id");
      await expect(bet.reversal("ROLLBACK", "REJECTED")).resolves.toHaveProperty("id");
    });

    test("promover uma reversão pendente a PROCESSED quando já existe outra é recusado", async () => {
      const bet = await processedBet();
      await bet.reversal("REFUND");
      const pending = await bet.reversal("ROLLBACK", "PENDING_REFERENCE");

      await expectDatabaseError(
        db.client.query(
          "update wager_transactions set status = 'PROCESSED', balance_after_amount = 10.00 where id = $1",
          [pending.id],
        ),
        { code: SQLSTATE.uniqueViolation, constraint: "wager_transactions_single_reversal_idx" },
      );
    });

    test("apostas diferentes podem ser revertidas, cada uma uma vez", async () => {
      const first = await processedBet();
      const second = await processedBet();

      await first.reversal("REFUND");
      await expect(second.reversal("REFUND")).resolves.toHaveProperty("id");
    });

    test("WIN e LOSS não são reversões: várias podem referenciar a mesma aposta", async () => {
      const bet = await processedBet();

      for (const kind of ["WIN", "WIN", "LOSS"]) {
        await expect(
          insert({
            kind,
            reference_external_transaction_id: bet.externalId,
            reference_transaction_id: bet.id,
            ...statusRow("PROCESSED"),
          }),
        ).resolves.toHaveProperty("id");
      }
    });

    test("duas reversões simultâneas da mesma aposta: só uma é aplicada", async () => {
      for (let round = 0; round < 20; round++) {
        const bet = await processedBet();
        const [first, second] = await Promise.all([db.connect(), db.connect()]);

        const attempt = (client: Client, kind: string) =>
          insertRow(
            client,
            "wager_transactions",
            transactionRow(wallet.id, {
              kind,
              reference_external_transaction_id: bet.externalId,
              reference_transaction_id: bet.id,
              ...statusRow("PROCESSED"),
            }),
          );

        const results = await Promise.allSettled([
          attempt(first, "REFUND"),
          attempt(second, "ROLLBACK"),
        ]);

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const loser = results.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult;
        expect(loser.reason.code).toBe(SQLSTATE.uniqueViolation);
        expect(loser.reason.constraint).toBe("wager_transactions_single_reversal_idx");
      }
    });
  });

  describe("transição de estado permitida", () => {
    const ALLOWED: [string, string, string][] = [
      [
        "PENDING → PROCESSED",
        "PENDING",
        "status = 'PROCESSED', balance_after_amount = 75.00, processed_at = now()",
      ],
      [
        "PENDING → REJECTED",
        "PENDING",
        "status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', balance_after_amount = 20.00, processed_at = now()",
      ],
      [
        "PENDING → PENDING_REFERENCE",
        "PENDING",
        "status = 'PENDING_REFERENCE', next_attempt_at = now()",
      ],
      [
        "PENDING → FAILED",
        "PENDING",
        "status = 'FAILED', failure_code = 'PROCESSING_FAILED', processed_at = now()",
      ],
      [
        "PENDING_REFERENCE → PROCESSED",
        "PENDING_REFERENCE",
        "status = 'PROCESSED', balance_after_amount = 75.00, processed_at = now()",
      ],
      [
        "PENDING_REFERENCE → REJECTED",
        "PENDING_REFERENCE",
        "status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', balance_after_amount = 20.00, processed_at = now()",
      ],
      [
        "PENDING_REFERENCE → FAILED",
        "PENDING_REFERENCE",
        "status = 'FAILED', failure_code = 'PROCESSING_FAILED', processed_at = now()",
      ],
      [
        "PENDING_REFERENCE: o worker conta a tentativa e agenda a próxima",
        "PENDING_REFERENCE",
        "reference_attempts = 3, next_attempt_at = now() + interval '8 seconds'",
      ],
    ];

    test.each(ALLOWED)("%s", async (_name, from, assignments) => {
      const row = await seed({ status: from });

      await db.client.query(`update wager_transactions set ${assignments} where id = $1`, [row.id]);

      const { rows } = await db.client.query(
        "select status from wager_transactions where id = $1",
        [row.id],
      );
      expect(rows).toHaveLength(1);
    });

    test("PENDING_REFERENCE → PROCESSED grava a referência resolvida", async () => {
      const bet = await seed(statusRow("PROCESSED"));
      const refund = await seed({
        kind: "REFUND",
        reference_external_transaction_id: bet.externalId,
        status: "PENDING_REFERENCE",
      });

      await db.client.query(
        `update wager_transactions
           set status = 'PROCESSED', reference_transaction_id = $1,
               balance_after_amount = 125.00, processed_at = now()
         where id = $2`,
        [bet.id, refund.id],
      );

      const { rows } = await db.client.query(
        "select status, reference_transaction_id from wager_transactions where id = $1",
        [refund.id],
      );
      expect(rows[0]).toEqual({ status: "PROCESSED", reference_transaction_id: bet.id });
    });
  });

  describe("estado terminal é imutável (trigger)", () => {
    const CHANGES = [
      "processed_at = now()",
      "failure_code = 'PROCESSING_FAILED'",
      "balance_after_amount = 1.00",
      "reference_attempts = 9",
      "next_attempt_at = now()",
      "status = 'PENDING'",
      "status = 'PENDING_REFERENCE'",
      "status = status",
    ];

    for (const status of TERMINAL_STATUSES) {
      test.each(CHANGES)(`${status}: UPDATE ... SET %s é recusado`, async (assignments) => {
        const row = await seed(statusRow(status));

        await expectDatabaseError(
          db.client.query(`update wager_transactions set ${assignments} where id = $1`, [row.id]),
          { code: SQLSTATE.integrityViolation, message: /estado terminal/ },
        );

        const { rows } = await db.client.query(
          "select status, failure_code from wager_transactions where id = $1",
          [row.id],
        );
        expect(rows[0]).toEqual(statusRow(status));
      });
    }

    test("a mensagem de erro informa o id da transação e o estado", async () => {
      const row = await seed(statusRow("PROCESSED"));

      await expectDatabaseError(
        db.client.query("update wager_transactions set processed_at = now() where id = $1", [
          row.id,
        ]),
        { code: SQLSTATE.integrityViolation, message: new RegExp(`${row.id}.*PROCESSED`) },
      );
    });

    test("estados não terminais continuam editáveis", async () => {
      for (const status of ["PENDING", "PENDING_REFERENCE"]) {
        const row = await seed({ status });

        await expect(
          db.client.query("update wager_transactions set reference_attempts = 1 where id = $1", [
            row.id,
          ]),
        ).resolves.toBeDefined();
      }
    });
  });

  describe("colunas de identidade e de negócio são imutáveis (trigger)", () => {
    const IMMUTABLE: [string, () => unknown][] = [
      ["id", () => randomUUID()],
      ["provider_id", () => "outro-provider"],
      ["external_transaction_id", () => "outro-ext"],
      ["idempotency_key", () => "outra-key"],
      ["payload_hash", () => "outro-hash"],
      ["wallet_id", () => otherWallet.id],
      ["player_id", () => "outro-player"],
      ["round_id", () => "outra-rodada"],
      ["game_id", () => "outro-jogo"],
      ["kind", () => "WIN"],
      ["amount", () => "99.00"],
      ["currency", () => "USD"],
      ["reference_external_transaction_id", () => "outra-referencia"],
      ["created_at", () => new Date("2020-01-01T00:00:00.000Z")],
    ];

    test.each(IMMUTABLE)("%s não pode mudar", async (column, newValue) => {
      const row = await seed({ status: "PENDING" });
      const before = await db.client.query(
        `select ${column}::text as value from wager_transactions where id = $1`,
        [row.id],
      );

      await expectDatabaseError(
        db.client.query(`update wager_transactions set ${column} = $1 where id = $2`, [
          newValue(),
          row.id,
        ]),
        { code: SQLSTATE.integrityViolation, message: /imutáveis/ },
      );

      const after = await db.client.query(
        `select ${column}::text as value from wager_transactions where id = $1`,
        [row.id],
      );
      expect(after.rows[0].value).toBe(before.rows[0].value);
    });

    test("também não mudam em PENDING_REFERENCE, mesmo junto com uma mudança permitida", async () => {
      const row = await seed({ status: "PENDING_REFERENCE" });

      await expectDatabaseError(
        db.client.query(
          "update wager_transactions set amount = 1.00, reference_attempts = 2 where id = $1",
          [row.id],
        ),
        { code: SQLSTATE.integrityViolation, message: /imutáveis/ },
      );

      const { rows } = await db.client.query(
        "select amount, reference_attempts from wager_transactions where id = $1",
        [row.id],
      );
      expect(rows[0]).toEqual({ amount: "25.00", reference_attempts: 0 });
    });
  });

  describe("transação não pode ser apagada (trigger)", () => {
    test.each(ALL_STATUSES)("DELETE de transação %s é recusado", async (status) => {
      const row = await seed(statusRow(status));

      await expectDatabaseError(
        db.client.query("delete from wager_transactions where id = $1", [row.id]),
        { code: SQLSTATE.integrityViolation, message: /imutável: DELETE/ },
      );

      const { rowCount } = await db.client.query("select 1 from wager_transactions where id = $1", [
        row.id,
      ]);
      expect(rowCount).toBe(1);
    });

    test("TRUNCATE também é recusado, inclusive em cascata a partir de wallets", async () => {
      await seed();

      await expectDatabaseError(db.client.query("truncate wager_transactions cascade"), {
        code: SQLSTATE.integrityViolation,
        message: /imutável: TRUNCATE/,
      });
      await expectDatabaseError(db.client.query("truncate wallets cascade"), {
        code: SQLSTATE.integrityViolation,
        message: /imutável: TRUNCATE/,
      });
    });
  });

  describe("índices", () => {
    const definitionOf = async (name: string): Promise<string> => {
      const { rows } = await db.client.query(
        "select indexdef from pg_indexes where schemaname = 'public' and indexname = $1",
        [name],
      );
      return rows[0]?.indexdef as string;
    };

    test("a reversão única é um índice UNIQUE parcial sobre reversões processadas", async () => {
      const definition = await definitionOf("wager_transactions_single_reversal_idx");

      expect(definition).toMatch(/CREATE UNIQUE INDEX/);
      expect(definition).toMatch(/\(reference_transaction_id\)/);
      expect(definition).toMatch(/WHERE/);
      expect(definition).toMatch(/REFUND/);
      expect(definition).toMatch(/ROLLBACK/);
      expect(definition).toMatch(/status = 'PROCESSED'/);
    });

    test("o índice do worker cobre só PENDING_REFERENCE e ordena por next_attempt_at", async () => {
      const definition = await definitionOf("wager_transactions_pending_reference_idx");

      expect(definition).toMatch(/CREATE INDEX/);
      expect(definition).not.toMatch(/UNIQUE/);
      expect(definition).toMatch(/\(next_attempt_at\)/);
      expect(definition).toMatch(/status = 'PENDING_REFERENCE'/);
    });
  });
});
