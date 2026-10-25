import { randomUUID } from "node:crypto";
import { GetQueueUrlCommand, SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";

const API = process.env.SMOKE_API ?? "http://localhost:3001";
const SQS_ENDPOINT = process.env.SMOKE_SQS_ENDPOINT ?? "http://localhost:4566";
const INPUT_QUEUE = process.env.SQS_TRANSACTIONS_QUEUE ?? "wager-transactions.fifo";
const COUNT = Number(process.argv[2] ?? 30);
const BATCH = 10;

const playerId = `queue-load-${randomUUID()}`;
const created = await fetch(`${API}/wallets`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } }),
});
const wallet = (await created.json()) as { id: string };

const client = new SQSClient({
  region: "us-east-1",
  endpoint: SQS_ENDPOINT,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const { QueueUrl } = await client.send(new GetQueueUrlCommand({ QueueName: INPUT_QUEUE }));

const messages = Array.from({ length: COUNT }, () => {
  const messageId = `msg-${randomUUID()}`;
  const externalTransactionId = `ext-${randomUUID()}`;

  return {
    Id: randomUUID(),
    MessageGroupId: randomUUID(),
    MessageDeduplicationId: messageId,
    MessageBody: JSON.stringify({
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "queue-load",
        externalTransactionId,
        playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "game-1",
        kind: "BET",
        money: { amount: "1.00", currency: "BRL" },
        idempotencyKey: `queue-load:${externalTransactionId}`,
      },
    }),
  };
});

let accepted = 0;

for (let start = 0; start < messages.length; start += BATCH) {
  const result = await client.send(
    new SendMessageBatchCommand({ QueueUrl, Entries: messages.slice(start, start + BATCH) }),
  );

  accepted += result.Successful?.length ?? 0;

  if (result.Failed?.length) {
    console.error("falhas no envio:", JSON.stringify(result.Failed));
  }
}

client.destroy();
console.log(
  JSON.stringify({
    walletId: wallet.id,
    enqueued: accepted,
    expectedBalance: `${1000 - accepted}.00`,
  }),
);
