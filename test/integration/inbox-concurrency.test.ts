import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { InboxMessage } from "../../src/modules/messaging/domain/inbox-message";
import { createGate, waitUntilSomeoneWaitsOnLock } from "../support/async";
import { type PersistenceHarness, startPersistence } from "../support/persistence";
import { AT } from "../support/wagering-builders";

const CONSUMER = "wager-transactions";

const message = (messageId: string, payloadHash: string) =>
  InboxMessage.receive({ consumerName: CONSUMER, messageId, payloadHash, receivedAt: AT });

describe("InboxRepository.tryReceive sob concorrência", () => {
  let h: PersistenceHarness;

  beforeAll(async () => {
    h = await startPersistence();
  });

  afterAll(async () => {
    await h.close();
  });

  const storedRows = async (messageId: string) =>
    (
      await h.db.client.query(
        "select payload_hash from inbox_messages where consumer_name = $1 and message_id = $2",
        [CONSUMER, messageId],
      )
    ).rows as { payload_hash: string }[];

  test("50 chamadas simultâneas com o mesmo (consumer, messageId): exatamente uma recebe 'nova'", async () => {
    const messageId = `msg-${randomUUID()}`;

    const receipts = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        h.uow.run(({ inbox }) => inbox.tryReceive(message(messageId, `hash-${index}`))),
      ),
    );

    const winners = receipts.filter((receipt) => receipt.isNew);
    expect(winners).toHaveLength(1);
    expect(receipts.filter((receipt) => !receipt.isNew)).toHaveLength(49);

    const winnerHash = winners[0]?.storedPayloadHash;
    expect(receipts.every((receipt) => receipt.storedPayloadHash === winnerHash)).toBe(true);

    const rows = await storedRows(messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload_hash).toBe(winnerHash as string);
  });

  test("50 mensagens diferentes ao mesmo tempo: todas são novas", async () => {
    const receipts = await Promise.all(
      Array.from({ length: 50 }, () =>
        h.uow.run(({ inbox }) => inbox.tryReceive(message(`msg-${randomUUID()}`, "hash"))),
      ),
    );

    expect(receipts.every((receipt) => receipt.isNew)).toBe(true);
  });

  test("a duplicata espera o commit do vencedor e então devolve o hash dele", async () => {
    const messageId = `msg-${randomUUID()}`;
    const firstReceived = createGate();
    const releaseFirst = createGate();

    const first = h.uow.run(async ({ inbox }) => {
      const receipt = await inbox.tryReceive(message(messageId, "hash-vencedora"));
      firstReceived.open();
      await releaseFirst.opened;
      return receipt;
    });

    await firstReceived.opened;
    const second = h.uow.run(({ inbox }) => inbox.tryReceive(message(messageId, "hash-outra")));

    await waitUntilSomeoneWaitsOnLock(h.db.client);
    releaseFirst.open();

    expect(await first).toEqual({ isNew: true, storedPayloadHash: "hash-vencedora" });
    expect(await second).toEqual({ isNew: false, storedPayloadHash: "hash-vencedora" });
  });

  test("se o vencedor sofre rollback, a mensagem não ficou registrada e a duplicata passa a ser a nova", async () => {
    const messageId = `msg-${randomUUID()}`;
    const firstReceived = createGate();
    const releaseFirst = createGate();
    const failure = new Error("processamento falhou");

    const first = h.uow.run(async ({ inbox }) => {
      await inbox.tryReceive(message(messageId, "hash-que-vai-sumir"));
      firstReceived.open();
      await releaseFirst.opened;
      throw failure;
    });

    await firstReceived.opened;
    const second = h.uow.run(({ inbox }) => inbox.tryReceive(message(messageId, "hash-segunda")));

    await waitUntilSomeoneWaitsOnLock(h.db.client);
    releaseFirst.open();

    await expect(first).rejects.toBe(failure);
    expect(await second).toEqual({ isNew: true, storedPayloadHash: "hash-segunda" });
    expect((await storedRows(messageId)).map((row) => row.payload_hash)).toEqual(["hash-segunda"]);
  });
});
