import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { InboxMessage } from "../../src/modules/messaging/domain/inbox-message";
import { OutboxMessage } from "../../src/modules/messaging/domain/outbox-message";
import { inboxMessageMapper } from "../../src/modules/messaging/infrastructure/inbox-message.mapper";
import { InboxMessageSchema } from "../../src/modules/messaging/infrastructure/inbox-message.schema";
import { outboxMessageMapper } from "../../src/modules/messaging/infrastructure/outbox-message.mapper";
import { OutboxMessageSchema } from "../../src/modules/messaging/infrastructure/outbox-message.schema";
import { WagerTransactionProcessed } from "../../src/modules/wagering/domain/events/wager-transaction-processed";
import { FailureCode } from "../../src/modules/wagering/domain/failure-code";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/modules/wagering/domain/wager-transaction";
import { LedgerDirection } from "../../src/modules/wallet/domain/ledger-direction";
import { Wallet } from "../../src/modules/wallet/domain/wallet";
import { WalletAlreadyExistsError } from "../../src/modules/wallet/domain/wallet-errors";
import { ledgerEntryMapper } from "../../src/modules/wallet/infrastructure/ledger-entry.mapper";
import { LedgerEntrySchema } from "../../src/modules/wallet/infrastructure/ledger-entry.schema";
import { MikroOrmLedgerRepository } from "../../src/modules/wallet/infrastructure/mikro-orm-ledger.repository";
import { AggregateNotFoundError } from "../../src/shared/application/persistence-errors";
import { expectDatabaseError, SQLSTATE } from "../support/database";
import { type PersistenceHarness, startPersistence } from "../support/persistence";
import {
  aNewTransaction,
  aNewWallet,
  anInboxMessage,
  anOutboxMessage,
  debitFor,
  LATER,
} from "../support/persistence-builders";
import { AT, aContext, brl, usd } from "../support/wagering-builders";

type Transaction = ReturnType<typeof aNewTransaction>;

describe("persistência: round-trip de cada agregado no Postgres real", () => {
  let h: PersistenceHarness;

  beforeAll(async () => {
    h = await startPersistence();
  });

  afterAll(async () => {
    await h.close();
  });

  const seedWallet = async (balance = brl("100.00")) => {
    const wallet = aNewWallet({ balance });
    await h.uow.run(({ wallets }) => wallets.add(wallet));
    return wallet;
  };

  describe("Wallet", () => {
    test("add + findById devolve uma wallet igual à original", async () => {
      const wallet = await seedWallet(brl("1234.56"));

      const loaded = await h.uow.run(({ wallets }) => wallets.findById(wallet.id));

      expect(loaded).toEqual(wallet);
      expect(loaded).not.toBe(wallet);
    });

    test("findByIdForUpdate e findByPlayerAndCurrency devolvem a mesma wallet", async () => {
      const wallet = await seedWallet();

      const locked = await h.uow.run(({ wallets }) => wallets.findByIdForUpdate(wallet.id));
      const byPlayer = await h.uow.run(({ wallets }) =>
        wallets.findByPlayerAndCurrency(wallet.playerId, "BRL"),
      );

      expect(locked).toEqual(wallet);
      expect(byPlayer).toEqual(wallet);
    });

    test("wallet inexistente, ou de outra moeda, devolve undefined", async () => {
      const wallet = await seedWallet();

      const result = await h.uow.run(async ({ wallets }) => ({
        unknownId: await wallets.findById(randomUUID()),
        unknownIdForUpdate: await wallets.findByIdForUpdate(randomUUID()),
        otherCurrency: await wallets.findByPlayerAndCurrency(wallet.playerId, "USD"),
        otherPlayer: await wallets.findByPlayerAndCurrency("ninguem", "BRL"),
      }));

      expect(result).toEqual({
        unknownId: undefined,
        unknownIdForUpdate: undefined,
        otherCurrency: undefined,
        otherPlayer: undefined,
      });
    });

    test("save persiste saldo, version e updatedAt depois de uma movimentação", async () => {
      const wallet = await seedWallet(brl("100.00"));
      const transaction = aNewTransaction(wallet.id);

      await h.uow.run(async ({ wallets, transactions }) => {
        await transactions.add(transaction);
        const locked = await wallets.findByIdForUpdate(wallet.id);
        if (!locked) {
          throw new Error("wallet deveria existir");
        }
        debitFor(locked, transaction, LATER);
        await wallets.save(locked);
      });

      const loaded = await h.uow.run(({ wallets }) => wallets.findById(wallet.id));

      expect(loaded?.balance.toJSON()).toEqual({ amount: "75.00", currency: "BRL" });
      expect(loaded?.version).toBe(2);
      expect(loaded?.updatedAt).toEqual(LATER);
      expect(loaded?.createdAt).toEqual(AT);
    });

    test("dentro do mesmo run, reler depois de save devolve o estado novo, sem cache", async () => {
      const wallet = await seedWallet(brl("100.00"));
      const transaction = aNewTransaction(wallet.id);

      const reread = await h.uow.run(async ({ wallets, transactions }) => {
        await transactions.add(transaction);
        const locked = await wallets.findByIdForUpdate(wallet.id);
        if (!locked) {
          throw new Error("wallet deveria existir");
        }
        debitFor(locked, transaction, LATER);
        await wallets.save(locked);

        return {
          plain: await wallets.findById(wallet.id),
          locked: await wallets.findByIdForUpdate(wallet.id),
          byPlayer: await wallets.findByPlayerAndCurrency(wallet.playerId, "BRL"),
        };
      });

      expect(reread.plain?.balance.toJSON().amount).toBe("75.00");
      expect(reread.locked?.version).toBe(2);
      expect(reread.byPlayer?.updatedAt).toEqual(LATER);
    });

    test("add com o mesmo jogador e moeda lança WalletAlreadyExistsError", async () => {
      const wallet = await seedWallet();
      const duplicate = aNewWallet({ playerId: wallet.playerId });

      await expect(h.uow.run(({ wallets }) => wallets.add(duplicate))).rejects.toBeInstanceOf(
        WalletAlreadyExistsError,
      );
    });

    test("add com o mesmo id mas outro jogador não é confundido com wallet duplicada", async () => {
      const wallet = await seedWallet();
      const sameId = Wallet.rehydrate({
        id: wallet.id,
        playerId: `outro-${randomUUID()}`,
        currency: "BRL",
        balance: brl("1.00"),
        version: 1,
        createdAt: AT,
        updatedAt: AT,
      });

      const failure = await h.uow
        .run(({ wallets }) => wallets.add(sameId))
        .catch((e: unknown) => e);

      expect(failure).not.toBeInstanceOf(WalletAlreadyExistsError);
      expect((failure as { constraint?: string }).constraint).toBe("wallets_pkey");
    });

    test("a mesma wallet em moeda diferente é aceita", async () => {
      const wallet = await seedWallet(brl("10.00"));
      const other = aNewWallet({ playerId: wallet.playerId, balance: usd("10.00") });

      await h.uow.run(({ wallets }) => wallets.add(other));

      expect(
        await h.uow.run(({ wallets }) => wallets.findByPlayerAndCurrency(wallet.playerId, "USD")),
      ).toEqual(other);
    });

    test("save de uma wallet que não existe falha com AggregateNotFoundError", async () => {
      const ghost = aNewWallet();

      await expect(h.uow.run(({ wallets }) => wallets.save(ghost))).rejects.toBeInstanceOf(
        AggregateNotFoundError,
      );
    });
  });

  describe("WagerTransaction", () => {
    const everyLookup = (transaction: Transaction) =>
      h.uow.run(async ({ transactions }) => [
        await transactions.findById(transaction.id),
        await transactions.findByIdempotencyKey(transaction.idempotencyKey),
        await transactions.findByProviderAndExternalId(
          transaction.providerId,
          transaction.externalTransactionId,
        ),
      ]);

    const saved = async (
      walletId: string,
      overrides: Parameters<typeof aNewTransaction>[1] = {},
    ) => {
      const transaction = aNewTransaction(walletId, overrides);
      await h.uow.run(({ transactions }) => transactions.add(transaction));
      return transaction;
    };

    const cases: [string, (walletId: string) => Transaction][] = [
      ["PENDING", (walletId) => aNewTransaction(walletId)],
      [
        "PENDING_REFERENCE",
        (walletId) =>
          aNewTransaction(walletId, {
            kind: WagerTransactionKind.Refund,
            referenceExternalTransactionId: "ext-bet-que-ainda-nao-chegou",
            status: WagerTransactionStatus.PendingReference,
          }),
      ],
      [
        "PROCESSED",
        (walletId) =>
          aNewTransaction(walletId, {
            status: WagerTransactionStatus.Processed,
            balanceAfter: brl("75.00"),
            processedAt: AT,
          }),
      ],
      [
        "REJECTED (INSUFFICIENT_FUNDS, com o saldo do momento)",
        (walletId) =>
          aNewTransaction(walletId, {
            status: WagerTransactionStatus.Rejected,
            failureCode: FailureCode.InsufficientFunds,
            balanceAfter: brl("10.00"),
            processedAt: AT,
          }),
      ],
      [
        "FAILED (sem saldo gravado)",
        (walletId) =>
          aNewTransaction(walletId, {
            status: WagerTransactionStatus.Failed,
            failureCode: FailureCode.ProcessingFailed,
            processedAt: AT,
          }),
      ],
    ];

    for (const [label, build] of cases) {
      test(`${label}: as três buscas devolvem uma transação igual à original`, async () => {
        const wallet = await seedWallet();
        const original = build(wallet.id);
        await h.uow.run(({ transactions }) => transactions.add(original));

        const [byId, byKey, byProvider] = await everyLookup(original);

        expect(byId).toEqual(original);
        expect(byKey).toEqual(original);
        expect(byProvider).toEqual(original);
      });
    }

    test("REJECTED por CURRENCY_MISMATCH guarda o saldo na moeda da wallet, não na da operação", async () => {
      const wallet = await seedWallet(brl("100.00"));
      const original = await saved(wallet.id, {
        money: usd("30.00"),
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.CurrencyMismatch,
        balanceAfter: brl("100.00"),
        processedAt: AT,
      });

      const [loaded] = await everyLookup(original);

      expect(loaded).toEqual(original);
      expect(loaded?.money.currency).toBe("USD");
      expect(loaded?.balanceAfter?.currency).toBe("BRL");
    });

    test("REFUND com referência resolvida preserva referenceTransactionId", async () => {
      const wallet = await seedWallet();
      const bet = await saved(wallet.id, {
        status: WagerTransactionStatus.Processed,
        balanceAfter: brl("75.00"),
        processedAt: AT,
      });
      const refund = await saved(wallet.id, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
        referenceTransactionId: bet.id,
        status: WagerTransactionStatus.Processed,
        balanceAfter: brl("100.00"),
        processedAt: AT,
      });

      const [loaded] = await everyLookup(refund);

      expect(loaded).toEqual(refund);
      expect(loaded?.referenceTransactionId).toBe(bet.id);
    });

    test("o mesmo id externo em provedores diferentes são transações diferentes, cada busca acha a sua", async () => {
      const wallet = await seedWallet();
      const shared = `ext-${randomUUID()}`;
      const fromA = await saved(wallet.id, {
        providerId: "provider-a",
        externalTransactionId: shared,
      });
      const fromB = await saved(wallet.id, {
        providerId: "provider-b",
        externalTransactionId: shared,
      });

      const [foundA, foundB, foundC] = await h.uow.run(async ({ transactions }) => [
        await transactions.findByProviderAndExternalId("provider-a", shared),
        await transactions.findByProviderAndExternalId("provider-b", shared),
        await transactions.findByProviderAndExternalId("provider-c", shared),
      ]);

      expect(foundA).toEqual(fromA);
      expect(foundB).toEqual(fromB);
      expect(foundC).toBeUndefined();
    });

    test("transação inexistente devolve undefined nas três buscas", async () => {
      const wallet = await seedWallet();

      expect(await everyLookup(aNewTransaction(wallet.id))).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    });

    test("save persiste PENDING → PENDING_REFERENCE → PROCESSED, e o que foi lido bate com o agregado", async () => {
      const wallet = await seedWallet();
      const bet = await saved(wallet.id, {
        status: WagerTransactionStatus.Processed,
        balanceAfter: brl("75.00"),
        processedAt: AT,
      });
      const refund = await saved(wallet.id, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
      });

      refund.markPendingReference(LATER);
      await h.uow.run(({ transactions }) => transactions.save(refund));
      expect(await h.uow.run(({ transactions }) => transactions.findById(refund.id))).toEqual(
        refund,
      );

      const pending = await h.uow.run(({ transactions }) => transactions.findById(refund.id));
      expect(pending?.nextAttemptAt).toEqual(LATER);
      expect(pending?.referenceAttempts).toBe(0);

      refund.markProcessed(bet.id, brl("100.00"), AT);
      await h.uow.run(({ transactions }) => transactions.save(refund));
      expect(await h.uow.run(({ transactions }) => transactions.findById(refund.id))).toEqual(
        refund,
      );

      const resolved = await h.uow.run(({ transactions }) => transactions.findById(refund.id));
      expect(resolved?.nextAttemptAt).toBeUndefined();
    });

    test("referenceAttempts e nextAttemptAt viajam inteiros pelo add e pelo findById", async () => {
      const wallet = await seedWallet();
      const waiting = await saved(wallet.id, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-que-nao-chegou",
        status: WagerTransactionStatus.PendingReference,
        referenceAttempts: 3,
        nextAttemptAt: LATER,
      });

      const loaded = await h.uow.run(({ transactions }) => transactions.findById(waiting.id));

      expect(loaded).toEqual(waiting);
      expect(loaded?.referenceAttempts).toBe(3);
      expect(loaded?.nextAttemptAt).toEqual(LATER);
    });

    test("save persiste novas tentativas e nova próxima tentativa de uma transação PENDING_REFERENCE", async () => {
      const wallet = await seedWallet();
      const waiting = await saved(wallet.id, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-que-nao-chegou",
        status: WagerTransactionStatus.PendingReference,
        referenceAttempts: 1,
        nextAttemptAt: AT,
      });
      const later = new Date(LATER.getTime() + 4000);
      const retried = aNewTransaction(wallet.id, {
        id: waiting.id,
        externalTransactionId: waiting.externalTransactionId,
        idempotencyKey: waiting.idempotencyKey,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: "ext-que-nao-chegou",
        status: WagerTransactionStatus.PendingReference,
        referenceAttempts: 2,
        nextAttemptAt: later,
      });

      await h.uow.run(({ transactions }) => transactions.save(retried));
      const loaded = await h.uow.run(({ transactions }) => transactions.findById(waiting.id));

      expect(loaded?.referenceAttempts).toBe(2);
      expect(loaded?.nextAttemptAt).toEqual(later);
    });

    test("dentro do mesmo run, reler a transação depois de save devolve o estado novo, sem cache", async () => {
      const wallet = await seedWallet();
      const transaction = await saved(wallet.id);

      const reread = await h.uow.run(async ({ transactions }) => {
        const before = await transactions.findById(transaction.id);
        transaction.markProcessed(undefined, brl("75.00"), LATER);
        await transactions.save(transaction);

        return { before, after: await transactions.findById(transaction.id) };
      });

      expect(reread.before?.status).toBe(WagerTransactionStatus.Pending);
      expect(reread.after).toEqual(transaction);
      expect(reread.after?.processedAt).toEqual(LATER);
    });

    test("save de transação rejeitada grava failureCode e saldo", async () => {
      const wallet = await seedWallet();
      const transaction = await saved(wallet.id);

      transaction.reject(FailureCode.InsufficientFunds, brl("10.00"), AT);
      await h.uow.run(({ transactions }) => transactions.save(transaction));

      expect(await h.uow.run(({ transactions }) => transactions.findById(transaction.id))).toEqual(
        transaction,
      );
    });

    test("o banco continua recusando alteração de transação terminal feita pelo repositório", async () => {
      const wallet = await seedWallet();
      const transaction = await saved(wallet.id, {
        status: WagerTransactionStatus.Processed,
        balanceAfter: brl("75.00"),
        processedAt: AT,
      });
      const tampered = aNewTransaction(wallet.id, {
        id: transaction.id,
        status: WagerTransactionStatus.Failed,
        failureCode: FailureCode.ProcessingFailed,
        processedAt: AT,
      });

      await expectDatabaseError(
        h.uow.run(({ transactions }) => transactions.save(tampered)),
        { code: SQLSTATE.integrityViolation, message: /estado terminal/ },
      );
    });

    test("save de transação que não existe falha com AggregateNotFoundError", async () => {
      const wallet = await seedWallet();

      await expect(
        h.uow.run(({ transactions }) => transactions.save(aNewTransaction(wallet.id))),
      ).rejects.toBeInstanceOf(AggregateNotFoundError);
    });
  });

  describe("WalletLedgerEntry", () => {
    const readEntry = async (id: string) => {
      const record = await h.orm.em
        .fork()
        .findOneOrFail(LedgerEntrySchema, { id }, { disableIdentityMap: true });
      return ledgerEntryMapper.toDomain(record);
    };

    test("DEBIT: append + leitura devolve um lançamento igual ao original", async () => {
      const wallet = await seedWallet(brl("100.00"));
      const transaction = aNewTransaction(wallet.id);
      const entry = debitFor(wallet, transaction);

      await h.uow.run(async ({ transactions, ledger, wallets }) => {
        await transactions.add(transaction);
        await ledger.append(entry);
        await wallets.save(wallet);
      });

      const loaded = await readEntry(entry.id);

      expect(loaded).toEqual(entry);
      expect(loaded.direction).toBe(LedgerDirection.Debit);
    });

    test("CREDIT: append + leitura devolve um lançamento igual ao original", async () => {
      const wallet = await seedWallet(brl("100.00"));
      const transaction = aNewTransaction(wallet.id, { kind: WagerTransactionKind.Win });
      const entry = wallet.credit({
        entryId: randomUUID(),
        transactionId: transaction.id,
        money: brl("40.00"),
        at: AT,
      });

      await h.uow.run(async ({ transactions, ledger, wallets }) => {
        await transactions.add(transaction);
        await ledger.append(entry);
        await wallets.save(wallet);
      });

      const loaded = await readEntry(entry.id);

      expect(loaded).toEqual(entry);
      expect(loaded.direction).toBe(LedgerDirection.Credit);
    });

    test("um segundo lançamento para a mesma transação é recusado pelo banco", async () => {
      const wallet = await seedWallet(brl("100.00"));
      const transaction = aNewTransaction(wallet.id);
      const first = debitFor(wallet, transaction);

      await h.uow.run(async ({ transactions, ledger, wallets }) => {
        await transactions.add(transaction);
        await ledger.append(first);
        await wallets.save(wallet);
      });

      const second = wallet.credit({
        entryId: randomUUID(),
        transactionId: transaction.id,
        money: brl("5.00"),
        at: AT,
      });

      await expectDatabaseError(
        h.uow.run(({ ledger }) => ledger.append(second)),
        { code: SQLSTATE.uniqueViolation, constraint: "wallet_ledger_entries_transaction_id_key" },
      );
    });

    test("o repositório do ledger só insere e lê: não expõe update nem delete", () => {
      const methods = Object.getOwnPropertyNames(MikroOrmLedgerRepository.prototype);

      expect(methods.sort()).toEqual(["append", "constructor", "findPage", "summarize"]);
    });
  });

  describe("InboxMessage", () => {
    const readInbox = async (consumerName: string, messageId: string) => {
      const record = await h.orm.em
        .fork()
        .findOneOrFail(
          InboxMessageSchema,
          { consumerName, messageId },
          { disableIdentityMap: true },
        );
      return inboxMessageMapper.toDomain(record);
    };

    test("tryReceive grava a mensagem e a leitura devolve uma igual à original", async () => {
      const message = anInboxMessage({ payloadHash: "hash-xyz" });

      const receipt = await h.uow.run(({ inbox }) => inbox.tryReceive(message));

      expect(receipt).toEqual({ isNew: true, storedPayloadHash: "hash-xyz" });
      expect(await readInbox(message.consumerName, message.messageId)).toEqual(message);
    });

    test("mensagem já processada preserva processedAt", async () => {
      const message = InboxMessage.rehydrate({
        consumerName: "wager-transactions",
        messageId: `msg-${randomUUID()}`,
        payloadHash: "hash-p",
        receivedAt: AT,
        processedAt: new Date("2026-01-01T12:00:05.000Z"),
      });

      await h.uow.run(({ inbox }) => inbox.tryReceive(message));

      expect(await readInbox(message.consumerName, message.messageId)).toEqual(message);
    });

    test("receber de novo o mesmo (consumer, messageId) devolve isNew=false e o hash gravado", async () => {
      const original = anInboxMessage({ payloadHash: "hash-original" });
      const duplicate = anInboxMessage({
        messageId: original.messageId,
        payloadHash: "hash-diferente",
      });

      await h.uow.run(({ inbox }) => inbox.tryReceive(original));
      const receipt = await h.uow.run(({ inbox }) => inbox.tryReceive(duplicate));

      expect(receipt).toEqual({ isNew: false, storedPayloadHash: "hash-original" });
      expect((await readInbox(original.consumerName, original.messageId)).payloadHash).toBe(
        "hash-original",
      );
    });

    test("o mesmo messageId em outro consumidor é uma mensagem nova", async () => {
      const first = anInboxMessage({ payloadHash: "hash-do-primeiro" });
      const otherConsumer = InboxMessage.receive({
        consumerName: "outro-consumidor",
        messageId: first.messageId,
        payloadHash: "hash-do-outro",
        receivedAt: AT,
      });

      await h.uow.run(({ inbox }) => inbox.tryReceive(first));
      const receipt = await h.uow.run(({ inbox }) => inbox.tryReceive(otherConsumer));
      const repeatedFirst = await h.uow.run(({ inbox }) => inbox.tryReceive(first));
      const repeatedOther = await h.uow.run(({ inbox }) => inbox.tryReceive(otherConsumer));

      expect(receipt).toEqual({ isNew: true, storedPayloadHash: "hash-do-outro" });
      expect(repeatedFirst).toEqual({ isNew: false, storedPayloadHash: "hash-do-primeiro" });
      expect(repeatedOther).toEqual({ isNew: false, storedPayloadHash: "hash-do-outro" });
    });
  });

  describe("OutboxMessage", () => {
    const readOutbox = async (id: string) => {
      const record = await h.orm.em
        .fork()
        .findOneOrFail(OutboxMessageSchema, { id }, { disableIdentityMap: true });
      return outboxMessageMapper.toDomain(record);
    };

    test("mensagem pendente (evento de saldo) volta igual, incluindo o payload", async () => {
      const wallet = aNewWallet();
      const message = anOutboxMessage(debitFor(wallet, aNewTransaction(wallet.id)));

      await h.uow.run(({ outbox }) => outbox.add(message));

      expect(await readOutbox(message.id)).toEqual(message);
    });

    test("evento de transação processada volta igual", async () => {
      const wallet = aNewWallet();
      const transaction = aNewTransaction(wallet.id, {
        status: WagerTransactionStatus.Processed,
        balanceAfter: brl("75.00"),
        processedAt: AT,
      });
      const message = OutboxMessage.enqueue(
        WagerTransactionProcessed.from(transaction, aContext({ eventId: randomUUID() })),
      );

      await h.uow.run(({ outbox }) => outbox.add(message));

      expect(await readOutbox(message.id)).toEqual(message);
    });

    test("mensagem com tentativas e já publicada preserva attempts, nextAttemptAt e publishedAt", async () => {
      const wallet = aNewWallet();
      const message = anOutboxMessage(debitFor(wallet, aNewTransaction(wallet.id)));
      message.scheduleRetry(AT);
      message.scheduleRetry(AT);
      message.markPublished(new Date("2026-01-01T12:01:00.000Z"));

      await h.uow.run(({ outbox }) => outbox.add(message));

      const loaded = await readOutbox(message.id);

      expect(loaded).toEqual(message);
      expect(loaded.attempts).toBe(2);
      expect(loaded.publishedAt).toEqual(new Date("2026-01-01T12:01:00.000Z"));
    });
  });
});
