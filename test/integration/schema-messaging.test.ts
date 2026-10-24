import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import {
  createMigratedDatabase,
  expectDatabaseError,
  SQLSTATE,
  type TestDatabase,
} from "../support/database";
import { inboxRow, insertRow, outboxRow } from "../support/schema-fixtures";

describe("schema: inbox_messages", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createMigratedDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  test("aceita uma mensagem recebida, ainda sem processed_at", async () => {
    const row = await insertRow(db.client, "inbox_messages", inboxRow());

    expect(row.processed_at).toBeNull();
  });

  test("rejeita o mesmo (consumer_name, message_id) duas vezes", async () => {
    const messageId = `msg-${randomUUID()}`;
    await insertRow(db.client, "inbox_messages", inboxRow({ message_id: messageId }));

    await expectDatabaseError(
      insertRow(db.client, "inbox_messages", inboxRow({ message_id: messageId })),
      { code: SQLSTATE.uniqueViolation, constraint: "inbox_messages_pkey" },
    );
  });

  test("a mesma mensagem em outro consumidor é aceita", async () => {
    const messageId = `msg-${randomUUID()}`;
    await insertRow(db.client, "inbox_messages", inboxRow({ message_id: messageId }));

    await expect(
      insertRow(
        db.client,
        "inbox_messages",
        inboxRow({ message_id: messageId, consumer_name: "outro-consumidor" }),
      ),
    ).resolves.toHaveProperty("message_id", messageId);
  });

  test("50 entregas simultâneas da mesma mensagem: só uma é registrada", async () => {
    const clients = await Promise.all(Array.from({ length: 50 }, () => db.connect()));
    const messageId = `msg-${randomUUID()}`;

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, index) =>
        insertRow(clients[index] as Client, "inbox_messages", inboxRow({ message_id: messageId })),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((item) => item.status === "rejected")) {
      expect((result as PromiseRejectedResult).reason.code).toBe(SQLSTATE.uniqueViolation);
    }
  });

  test("a mensagem pode ser marcada como processada depois", async () => {
    const row = await insertRow(db.client, "inbox_messages", inboxRow());

    await db.client.query(
      "update inbox_messages set processed_at = now() where consumer_name = $1 and message_id = $2",
      [row.consumer_name, row.message_id],
    );

    const { rows } = await db.client.query(
      "select processed_at from inbox_messages where message_id = $1",
      [row.message_id],
    );
    expect(rows[0].processed_at).not.toBeNull();
  });

  test("rejeita campos obrigatórios nulos", async () => {
    await expectDatabaseError(
      insertRow(db.client, "inbox_messages", inboxRow({ payload_hash: null })),
      { code: "23502" },
    );
  });
});

describe("schema: outbox_messages", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createMigratedDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  test("aceita um evento pendente: attempts 0 e sem published_at", async () => {
    const row = await insertRow(db.client, "outbox_messages", outboxRow());

    expect(row.attempts).toBe(0);
    expect(row.published_at).toBeNull();
  });

  test("guarda o envelope como jsonb e devolve o objeto", async () => {
    const payload = {
      eventType: "WalletBalanceChanged",
      version: 1,
      data: { money: { amount: "25.00", currency: "BRL" } },
    };

    const row = await insertRow(db.client, "outbox_messages", outboxRow({ payload }));

    expect(row.payload).toEqual(payload);
  });

  test("rejeita attempts negativo", async () => {
    await expectDatabaseError(
      insertRow(db.client, "outbox_messages", outboxRow({ attempts: -1 })),
      {
        code: SQLSTATE.checkViolation,
        constraint: "outbox_messages_attempts_non_negative",
      },
    );
  });

  test("rejeita o mesmo id de evento duas vezes (o eventId nunca duplica a outbox)", async () => {
    const id = randomUUID();
    await insertRow(db.client, "outbox_messages", outboxRow({ id }));

    await expectDatabaseError(insertRow(db.client, "outbox_messages", outboxRow({ id })), {
      code: SQLSTATE.uniqueViolation,
      constraint: "outbox_messages_pkey",
    });
  });

  test("seq cresce a cada evento, dando a ordem de publicação", async () => {
    const first = await insertRow(db.client, "outbox_messages", outboxRow());
    const second = await insertRow(db.client, "outbox_messages", outboxRow());

    expect(BigInt(second.seq as string)).toBeGreaterThan(BigInt(first.seq as string));
  });

  test("o publisher pode marcar como publicado e agendar retry (a outbox não é imutável)", async () => {
    const row = await insertRow(db.client, "outbox_messages", outboxRow());

    await db.client.query(
      "update outbox_messages set attempts = attempts + 1, next_attempt_at = now() + interval '1 second' where id = $1",
      [row.id],
    );
    await db.client.query("update outbox_messages set published_at = now() where id = $1", [
      row.id,
    ]);

    const { rows } = await db.client.query(
      "select attempts, published_at from outbox_messages where id = $1",
      [row.id],
    );
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].published_at).not.toBeNull();
  });

  test("o índice de pendentes é parcial: cobre só o que ainda não foi publicado", async () => {
    const { rows } = await db.client.query(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'outbox_messages_pending_idx'",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/\(next_attempt_at\)/);
    expect(rows[0].indexdef).toMatch(/WHERE \(published_at IS NULL\)/);
  });
});
