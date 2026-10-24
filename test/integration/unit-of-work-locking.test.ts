import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { LockTimeoutError } from "../../src/shared/application/persistence-errors";
import { createGate, waitUntilSomeoneWaitsOnLock } from "../support/async";
import { type PersistenceHarness, startPersistence } from "../support/persistence";
import { aNewTransaction, aNewWallet } from "../support/persistence-builders";
import { AT, brl } from "../support/wagering-builders";

describe("UnitOfWork: findByIdForUpdate segura a wallet até o commit", () => {
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

  test("a segunda transação espera a primeira terminar e enxerga o que ela gravou", async () => {
    const wallet = await seedWallet(brl("100.00"));
    const events: string[] = [];
    const firstHasLock = createGate();
    const releaseFirst = createGate();

    const first = h.uow.run(async ({ wallets }) => {
      const locked = await wallets.findByIdForUpdate(wallet.id);
      if (!locked) {
        throw new Error("wallet deveria existir");
      }
      events.push("A: lock obtido");
      firstHasLock.open();

      await releaseFirst.opened;

      locked.credit({
        entryId: randomUUID(),
        transactionId: randomUUID(),
        money: brl("50.00"),
        at: AT,
      });
      await wallets.save(locked);
      events.push("A: saldo gravado, vai commitar");
    });

    await firstHasLock.opened;

    const second = h.uow.run(async ({ wallets }) => {
      const locked = await wallets.findByIdForUpdate(wallet.id);
      if (!locked) {
        throw new Error("wallet deveria existir");
      }
      events.push(`B: lock obtido com saldo ${locked.balance.toJSON().amount}`);

      locked.debit({
        entryId: randomUUID(),
        transactionId: randomUUID(),
        money: brl("120.00"),
        at: AT,
      });
      await wallets.save(locked);
      events.push("B: saldo gravado");
    });

    await waitUntilSomeoneWaitsOnLock(h.db.client);
    expect(events).toEqual(["A: lock obtido"]);

    releaseFirst.open();
    await Promise.all([first, second]);

    expect(events).toEqual([
      "A: lock obtido",
      "A: saldo gravado, vai commitar",
      "B: lock obtido com saldo 150.00",
      "B: saldo gravado",
    ]);

    const final = await h.uow.run(({ wallets }) => wallets.findById(wallet.id));
    expect(final?.balance.toJSON().amount).toBe("30.00");
    expect(final?.version).toBe(3);
  });

  test("um rollback da primeira transação também libera a segunda, sem efeitos da primeira", async () => {
    const wallet = await seedWallet(brl("100.00"));
    const firstHasLock = createGate();
    const releaseFirst = createGate();
    const failure = new Error("A desiste");

    const first = h.uow.run(async ({ wallets }) => {
      const locked = await wallets.findByIdForUpdate(wallet.id);
      if (!locked) {
        throw new Error("wallet deveria existir");
      }
      locked.credit({
        entryId: randomUUID(),
        transactionId: randomUUID(),
        money: brl("999.00"),
        at: AT,
      });
      await wallets.save(locked);
      firstHasLock.open();
      await releaseFirst.opened;
      throw failure;
    });

    await firstHasLock.opened;
    const second = h.uow.run(({ wallets }) => wallets.findByIdForUpdate(wallet.id));

    await waitUntilSomeoneWaitsOnLock(h.db.client);
    releaseFirst.open();

    await expect(first).rejects.toBe(failure);
    expect((await second)?.balance.toJSON().amount).toBe("100.00");
  });

  test("leitura sem lock (findById) não espera a transação que segura o lock", async () => {
    const wallet = await seedWallet();
    const holderHasLock = createGate();
    const releaseHolder = createGate();

    const holder = h.uow.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(wallet.id);
      holderHasLock.open();
      await releaseHolder.opened;
    });

    await holderHasLock.opened;
    const read = await h.uow.run(({ wallets }) => wallets.findById(wallet.id));
    expect(read).toEqual(wallet);

    releaseHolder.open();
    await holder;
  });

  test("wallets diferentes não se bloqueiam: não há lock global", async () => {
    const [walletA, walletB] = [await seedWallet(), await seedWallet()];
    const holderHasLock = createGate();
    const releaseHolder = createGate();
    const quick = h.unitOfWork(1000);

    const holder = h.uow.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(walletA.id);
      holderHasLock.open();
      await releaseHolder.opened;
    });

    await holderHasLock.opened;
    const other = await quick.run(({ wallets }) => wallets.findByIdForUpdate(walletB.id));
    expect(other?.id).toBe(walletB.id);

    releaseHolder.open();
    await holder;
  });

  test("lock_timeout: quem espera mais que o limite falha com LockTimeoutError, e a outra transação segue intacta", async () => {
    const wallet = await seedWallet();
    const holderHasLock = createGate();
    const releaseHolder = createGate();
    const events: string[] = [];
    const limitMs = 200;

    const holder = h.uow.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(wallet.id);
      holderHasLock.open();
      await releaseHolder.opened;
      events.push("holder: terminou");
    });

    await holderHasLock.opened;

    const marker = aNewTransaction(wallet.id);
    const startedAt = performance.now();
    const failure = await h
      .unitOfWork(limitMs)
      .run(async ({ wallets, transactions }) => {
        await transactions.add(marker);
        await wallets.findByIdForUpdate(wallet.id);
      })
      .catch((error: unknown) => error);
    const waitedMs = performance.now() - startedAt;

    expect(failure).toBeInstanceOf(LockTimeoutError);
    expect((failure as LockTimeoutError).code).toBe("LOCK_TIMEOUT");
    expect((failure as LockTimeoutError).message).toContain(`${limitMs}ms`);
    expect(((failure as LockTimeoutError).cause as { code?: string }).code).toBe("55P03");
    expect(waitedMs).toBeGreaterThanOrEqual(limitMs - 10);
    expect(events).toEqual([]);

    releaseHolder.open();
    await holder;
    expect(events).toEqual(["holder: terminou"]);

    const leftover = await h.uow.run(({ transactions }) => transactions.findById(marker.id));
    expect(leftover).toBeUndefined();
  });

  test("depois de um lock_timeout o mesmo UnitOfWork continua utilizável", async () => {
    const wallet = await seedWallet();
    const holderHasLock = createGate();
    const releaseHolder = createGate();
    const quick = h.unitOfWork(100);

    const holder = h.uow.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(wallet.id);
      holderHasLock.open();
      await releaseHolder.opened;
    });

    await holderHasLock.opened;
    await expect(
      quick.run(({ wallets }) => wallets.findByIdForUpdate(wallet.id)),
    ).rejects.toBeInstanceOf(LockTimeoutError);

    releaseHolder.open();
    await holder;

    const again = await quick.run(({ wallets }) => wallets.findByIdForUpdate(wallet.id));
    expect(again?.id).toBe(wallet.id);
  });
});
