import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../src/modules/messaging/domain/outbox-message";
import { InsufficientFundsError } from "../../src/modules/wallet/domain/wallet-errors";
import type { Repositories } from "../../src/shared/application/unit-of-work.port";
import { createRepositories } from "../../src/shared/infrastructure/database/create-repositories";
import { MikroOrmUnitOfWork } from "../../src/shared/infrastructure/database/mikro-orm-unit-of-work";
import { buildOrmOptions } from "../../src/shared/infrastructure/database/orm-options";
import { createGate } from "../support/async";
import { expectDatabaseError, SQLSTATE } from "../support/database";
import { type PersistenceHarness, startPersistence } from "../support/persistence";
import {
  aNewTransaction,
  aNewWallet,
  anInboxMessage,
  anOutboxMessage,
  debitFor,
} from "../support/persistence-builders";
import { AT, brl } from "../support/wagering-builders";

describe("UnitOfWork: uma transação para todos os repositórios", () => {
  let h: PersistenceHarness;

  beforeAll(async () => {
    h = await startPersistence();
  });

  afterAll(async () => {
    await h.close();
  });

  const seedWallet = async () => {
    const wallet = aNewWallet({ balance: brl("100.00") });
    await h.uow.run(({ wallets }) => wallets.add(wallet));
    return wallet;
  };

  const visibleFromOutside = async (ids: {
    walletId: string;
    transactionId: string;
    messageId: string;
    outboxId: string;
  }) => {
    const { rows } = await h.db.client.query(
      `select
         (select count(*)::int from wager_transactions where id = $1) as transactions,
         (select count(*)::int from wallet_ledger_entries where transaction_id = $1) as ledger,
         (select count(*)::int from inbox_messages where message_id = $2) as inbox,
         (select count(*)::int from outbox_messages where id = $3) as outbox,
         (select balance::text from wallets where id = $4) as balance,
         (select version from wallets where id = $4) as version`,
      [ids.transactionId, ids.messageId, ids.outboxId, ids.walletId],
    );

    return rows[0] as Record<string, unknown>;
  };

  const fullOperation = async (
    repositories: Repositories,
    walletId: string,
    steps: { transactionId: string; messageId: string; outboxId?: string },
  ) => {
    const { wallets, transactions, ledger, inbox, outbox } = repositories;

    const wallet = await wallets.findByIdForUpdate(walletId);
    if (!wallet) {
      throw new Error("wallet deveria existir");
    }

    const message = anInboxMessage({ messageId: steps.messageId });
    await inbox.tryReceive(message);

    const transaction = aNewTransaction(walletId, { id: steps.transactionId });
    const entry = debitFor(wallet, transaction);
    transaction.markProcessed(undefined, wallet.balance, AT);

    await transactions.add(transaction);
    await ledger.append(entry);
    await wallets.save(wallet);

    const event = anOutboxMessage(entry);
    await outbox.add(
      steps.outboxId
        ? OutboxMessage.rehydrate({
            id: steps.outboxId,
            aggregateId: event.aggregateId,
            eventType: event.eventType,
            payload: event.payload,
            occurredAt: event.occurredAt,
            attempts: 0,
            nextAttemptAt: event.occurredAt,
          })
        : event,
    );

    return { eventId: event.id };
  };

  test("commit atômico: wallet, transação, ledger, inbox e outbox aparecem juntos, e só no commit", async () => {
    const wallet = await seedWallet();
    const ids = {
      walletId: wallet.id,
      transactionId: randomUUID(),
      messageId: `msg-${randomUUID()}`,
      outboxId: randomUUID(),
    };

    let duringTransaction: Record<string, unknown> = {};

    await h.uow.run(async (repositories) => {
      const { eventId } = await fullOperation(repositories, wallet.id, ids);
      duringTransaction = await visibleFromOutside({ ...ids, outboxId: eventId });
    });

    expect(duringTransaction).toEqual({
      transactions: 0,
      ledger: 0,
      inbox: 0,
      outbox: 0,
      balance: "100.00",
      version: 1,
    });

    const afterCommit = await h.db.client.query(
      `select
         (select count(*)::int from wager_transactions where id = $1) as transactions,
         (select count(*)::int from wallet_ledger_entries where transaction_id = $1) as ledger,
         (select count(*)::int from inbox_messages where message_id = $2) as inbox,
         (select count(*)::int from outbox_messages where aggregate_id = $3) as outbox,
         (select balance::text from wallets where id = $3) as balance,
         (select version from wallets where id = $3) as version`,
      [ids.transactionId, ids.messageId, wallet.id],
    );

    expect(afterCommit.rows[0]).toEqual({
      transactions: 1,
      ledger: 1,
      inbox: 1,
      outbox: 1,
      balance: "75.00",
      version: 2,
    });
  });

  test("rollback atômico: falha injetada depois de salvar wallet e ledger não deixa nada", async () => {
    const wallet = await seedWallet();
    const ids = {
      walletId: wallet.id,
      transactionId: randomUUID(),
      messageId: `msg-${randomUUID()}`,
      outboxId: randomUUID(),
    };
    const injected = new Error("falha injetada");
    let eventId = "";

    await expect(
      h.uow.run(async (repositories) => {
        ({ eventId } = await fullOperation(repositories, wallet.id, ids));
        throw injected;
      }),
    ).rejects.toBe(injected);

    expect(await visibleFromOutside({ ...ids, outboxId: eventId })).toEqual({
      transactions: 0,
      ledger: 0,
      inbox: 0,
      outbox: 0,
      balance: "100.00",
      version: 1,
    });
  });

  test("rollback atômico: erro do próprio banco no último passo desfaz os anteriores", async () => {
    const wallet = await seedWallet();
    const existingOutbox = anOutboxMessage(debitFor(aNewWallet(), aNewTransaction(randomUUID())));
    await h.uow.run(({ outbox }) => outbox.add(existingOutbox));

    const ids = {
      walletId: wallet.id,
      transactionId: randomUUID(),
      messageId: `msg-${randomUUID()}`,
      outboxId: existingOutbox.id,
    };

    await expectDatabaseError(
      h.uow.run((repositories) => fullOperation(repositories, wallet.id, ids)),
      { code: SQLSTATE.uniqueViolation, constraint: "outbox_messages_pkey" },
    );

    expect(await visibleFromOutside(ids)).toEqual({
      transactions: 0,
      ledger: 0,
      inbox: 0,
      outbox: 1,
      balance: "100.00",
      version: 1,
    });
  });

  test("erros de domínio lançados no callback chegam intactos a quem chamou", async () => {
    const wallet = await seedWallet();

    const failure = await h.uow
      .run(async ({ wallets }) => {
        const locked = await wallets.findByIdForUpdate(wallet.id);
        if (!locked) {
          throw new Error("wallet deveria existir");
        }
        debitFor(locked, aNewTransaction(wallet.id, { money: brl("500.00") }));
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InsufficientFundsError);
  });

  test("o valor devolvido pelo callback é o valor devolvido pelo run", async () => {
    expect(await h.uow.run(async () => "resultado")).toBe("resultado");
  });

  test("runs concorrentes são transações independentes: o rollback de uma não afeta a outra", async () => {
    const committed = aNewWallet();
    const abandoned = aNewWallet();
    const abandonedWritten = createGate();
    const committedDone = createGate();
    const failure = new Error("run A desiste");

    const runA = h.uow.run(async ({ wallets }) => {
      await wallets.add(abandoned);
      abandonedWritten.open();
      await committedDone.opened;
      throw failure;
    });

    await abandonedWritten.opened;
    await h.uow.run(({ wallets }) => wallets.add(committed));
    committedDone.open();

    await expect(runA).rejects.toBe(failure);

    const survivors = await h.uow.run(async ({ wallets }) => ({
      committed: await wallets.findById(committed.id),
      abandoned: await wallets.findById(abandoned.id),
    }));

    expect(survivors.committed).toEqual(committed);
    expect(survivors.abandoned).toBeUndefined();
  });

  test("cada run recebe repositórios próprios, ligados à sua transação", async () => {
    const seen: Repositories[] = [];

    await Promise.all([
      h.uow.run(async (repositories) => void seen.push(repositories)),
      h.uow.run(async (repositories) => void seen.push(repositories)),
    ]);

    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]?.wallets).not.toBe(seen[1]?.wallets);
  });

  test("não aceita lock_timeout inválido", () => {
    for (const invalid of [0, -1, 1.5, Number.NaN]) {
      expect(() => h.unitOfWork(invalid)).toThrow(/lockTimeoutMs inválido/);
    }
  });
});

describe("UnitOfWork: lock_timeout vale só dentro da transação (SET LOCAL)", () => {
  let h: PersistenceHarness;
  let singleConnectionOrm: MikroORM;

  beforeAll(async () => {
    h = await startPersistence();
    singleConnectionOrm = await MikroORM.init({
      ...buildOrmOptions(h.db.url),
      pool: { min: 1, max: 1 },
    });
  });

  afterAll(async () => {
    await singleConnectionOrm.close();
    await h.close();
  });

  test("dentro do run o lock_timeout é o configurado e depois que ele termina volta ao padrão", async () => {
    type TransactionEm = Parameters<typeof createRepositories>[0];
    const probe: { em?: TransactionEm } = {};
    const probeFactory = (em: TransactionEm) => {
      probe.em = em;
      return createRepositories(em);
    };
    const uow = new MikroOrmUnitOfWork(singleConnectionOrm, probeFactory, { lockTimeoutMs: 1234 });
    const show = async () =>
      (await singleConnectionOrm.em.fork().execute("show lock_timeout"))[0]?.lock_timeout;

    expect(await show()).toBe("0");

    const during = await uow.run(async () => {
      const rows = await probe.em?.execute("show lock_timeout");
      return rows?.[0]?.lock_timeout;
    });

    expect(during).toBe("1234ms");
    expect(await show()).toBe("0");
    expect(await show()).toBe("0");
  });
});
