import { type LoadClient, type Sample, type TransactionRequest } from "./client";
import { runClosedLoop } from "./engine";
import { toCents } from "./money";
import type { LoadSettings } from "./settings";

const PROVIDER = "load";
const CURRENCY = "BRL";

export interface ScenarioContext {
  client: LoadClient;
  settings: LoadSettings;
  runId: string;
  round: number;
}

export interface WalletExpectation {
  id: string;
  expectedCents: bigint;
}

export interface Prepared {
  wallets: { id: string; playerId: string }[];
}

export interface Execution {
  samples: Sample[];
  durationMs: number;
  concurrency: number;
  wallets: WalletExpectation[];
  transactionRows: number;
  ledgerEntries: number;
  pendingIds: string[];
  notes: string[];
}

export interface Scenario {
  id: string;
  title: string;
  description: string;
  prepare(context: ScenarioContext): Promise<Prepared>;
  execute(context: ScenarioContext, prepared: Prepared): Promise<Execution>;
}

const DISTINCT_WALLET_NET_CENTS = -1000n + 2500n - 500n - 250n + 250n;

const money = (amount: string) => ({ amount, currency: CURRENCY });

function request(
  wallet: { id: string; playerId: string },
  externalTransactionId: string,
  roundId: string,
  kind: TransactionRequest["kind"],
  amount: string,
  reference?: string,
): TransactionRequest {
  return {
    providerId: PROVIDER,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId,
    gameId: "load-game",
    kind,
    money: money(amount),
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  };
}

async function createWallets(
  context: ScenarioContext,
  tag: string,
  count: number,
  initialAmount: string,
): Promise<Prepared> {
  const wallets = Array.from({ length: count }, (_, index) => ({
    id: "",
    playerId: `load-${context.runId}-r${context.round}-${tag}-${index}`,
  }));

  await runClosedLoop(context.settings.concurrency, wallets, async (wallet) => {
    wallet.id = await context.client.createWallet(wallet.playerId, initialAmount);
  });

  return { wallets };
}

export const distinctWallets: Scenario = {
  id: "distinct-wallets",
  title: "Wallets distintas (sem disputa)",
  description:
    "Cada trabalhador percorre uma wallet inteira em sequência (BET, WIN, BET, LOSS, BET, REFUND). " +
    "Wallets diferentes não disputam lock.",

  prepare: (context) => createWallets(context, "s1", context.settings.distinctWallets, "1000.00"),

  async execute(context, prepared) {
    const samples: Sample[] = [];
    const { client } = context;

    const durationMs = await runClosedLoop(
      context.settings.concurrency,
      prepared.wallets,
      async (wallet, index) => {
        const prefix = `${context.runId}-r${context.round}-s1-${index}`;
        const send = async (op: string, body: TransactionRequest) => {
          samples.push(await client.transaction(op, body));
        };

        await send("BET", request(wallet, `${prefix}-bet-a`, `${prefix}-a`, "BET", "10.00"));
        await send(
          "WIN",
          request(wallet, `${prefix}-win-a`, `${prefix}-a`, "WIN", "25.00", `${prefix}-bet-a`),
        );
        await send("BET", request(wallet, `${prefix}-bet-b`, `${prefix}-b`, "BET", "5.00"));
        await send(
          "LOSS",
          request(wallet, `${prefix}-loss-b`, `${prefix}-b`, "LOSS", "5.00", `${prefix}-bet-b`),
        );
        await send("BET", request(wallet, `${prefix}-bet-c`, `${prefix}-c`, "BET", "2.50"));
        await send(
          "REFUND",
          request(wallet, `${prefix}-refund-c`, `${prefix}-c`, "REFUND", "2.50", `${prefix}-bet-c`),
        );
      },
    );

    return {
      samples,
      durationMs,
      concurrency: context.settings.concurrency,
      wallets: prepared.wallets.map((wallet) => ({
        id: wallet.id,
        expectedCents: toCents("1000.00") + DISTINCT_WALLET_NET_CENTS,
      })),
      transactionRows: prepared.wallets.length * 7,
      ledgerEntries: prepared.wallets.length * 6,
      pendingIds: [],
      notes: [],
    };
  },
};

export const hotWallet: Scenario = {
  id: "hot-wallet",
  title: "Hot wallet (uma wallet, muita concorrência)",
  description:
    "Uma única wallet com saldo alto recebe BETs de 1.00 de todos os trabalhadores ao mesmo tempo: " +
    "todas as transações disputam o mesmo lock pessimista.",

  prepare: (context) => createWallets(context, "s2", 1, "1000000.00"),

  async execute(context, prepared) {
    const wallet = prepared.wallets[0] as { id: string; playerId: string };
    const bets = Array.from({ length: context.settings.hotWalletBets }, (_, index) => index);
    const samples: Sample[] = [];

    const durationMs = await runClosedLoop(context.settings.concurrency, bets, async (index) => {
      const external = `${context.runId}-r${context.round}-s2-${index}`;
      samples.push(
        await context.client.transaction(
          "BET",
          request(wallet, external, `${external}-round`, "BET", "1.00"),
        ),
      );
    });

    return {
      samples,
      durationMs,
      concurrency: context.settings.concurrency,
      wallets: [
        { id: wallet.id, expectedCents: toCents("1000000.00") - BigInt(bets.length) * 100n },
      ],
      transactionRows: 1 + bets.length,
      ledgerEntries: 1 + bets.length,
      pendingIds: [],
      notes: [],
    };
  },
};

export const replayStorm: Scenario = {
  id: "replay-storm",
  title: "Tempestade de replays (mesma Idempotency-Key)",
  description:
    "Poucas BETs, cada uma reenviada centenas de vezes em paralelo com a mesma Idempotency-Key e o mesmo corpo. " +
    "O esperado é um único efeito por chave.",

  prepare: (context) => createWallets(context, "s3", context.settings.replayKeys, "1000.00"),

  async execute(context, prepared) {
    const { replayKeys, replayRequests } = context.settings;
    const orders = Array.from({ length: replayRequests }, (_, index) => index % replayKeys);
    const samples: Sample[] = [];
    const bodies = prepared.wallets.map((wallet, index) =>
      request(
        wallet,
        `${context.runId}-r${context.round}-s3-${index}`,
        `${context.runId}-r${context.round}-s3-${index}-round`,
        "BET",
        "10.00",
      ),
    );

    const durationMs = await runClosedLoop(
      context.settings.concurrency,
      orders,
      async (keyIndex) => {
        samples.push(
          await context.client.transaction("BET (replay)", bodies[keyIndex] as TransactionRequest),
        );
      },
    );

    return {
      samples,
      durationMs,
      concurrency: context.settings.concurrency,
      wallets: prepared.wallets.map((wallet) => ({
        id: wallet.id,
        expectedCents: toCents("990.00"),
      })),
      transactionRows: replayKeys * 2,
      ledgerEntries: replayKeys * 2,
      pendingIds: [],
      notes: [`${replayRequests} requisições sobre ${replayKeys} chaves distintas`],
    };
  },
};

export const mixedReversals: Scenario = {
  id: "mixed-reversals",
  title: "Misto com reversões (algumas antes da referência)",
  description:
    "Pares BET + REFUND/ROLLBACK sobre poucas wallets, em paralelo. Uma parte das reversões é enviada antes da BET " +
    "que ela referencia (202, resolvida depois pelo worker de pendências).",

  prepare: (context) => createWallets(context, "s4", context.settings.mixedWallets, "1000.00"),

  async execute(context, prepared) {
    const { mixedPairsPerWallet, earlyReversalPercent } = context.settings;
    const pairs = prepared.wallets
      .flatMap((wallet, walletIndex) =>
        Array.from({ length: mixedPairsPerWallet }, (_, pairIndex) => ({
          wallet,
          walletIndex,
          pairIndex,
          early: (walletIndex * mixedPairsPerWallet + pairIndex) % 100 < earlyReversalPercent,
        })),
      )
      .sort(
        (a, b) =>
          ((a.pairIndex * 7 + a.walletIndex) % 13) - ((b.pairIndex * 7 + b.walletIndex) % 13),
      );
    const samples: Sample[] = [];
    const pendingIds: string[] = [];

    const durationMs = await runClosedLoop(context.settings.concurrency, pairs, async (pair) => {
      const base = `${context.runId}-r${context.round}-s4-${pair.walletIndex}-${pair.pairIndex}`;
      const round = `${base}-round`;
      const reversalKind = pair.pairIndex % 2 === 0 ? "REFUND" : "ROLLBACK";
      const bet = request(pair.wallet, `${base}-bet`, round, "BET", "10.00");
      const reversal = request(
        pair.wallet,
        `${base}-rev`,
        round,
        reversalKind,
        "10.00",
        `${base}-bet`,
      );

      if (pair.early) {
        const early = await context.client.transaction(`${reversalKind} (antes da BET)`, reversal);
        samples.push(early);

        if (early.status === 202 && early.transactionId) {
          pendingIds.push(early.transactionId);
        }

        samples.push(await context.client.transaction("BET", bet));
      } else {
        samples.push(await context.client.transaction("BET", bet));
        samples.push(await context.client.transaction(reversalKind, reversal));
      }
    });

    const total = pairs.length;

    return {
      samples,
      durationMs,
      concurrency: context.settings.concurrency,
      wallets: prepared.wallets.map((wallet) => ({
        id: wallet.id,
        expectedCents: toCents("1000.00"),
      })),
      transactionRows: prepared.wallets.length + total * 2,
      ledgerEntries: prepared.wallets.length + total * 2,
      pendingIds,
      notes: [
        `${total} pares, ${pairs.filter((pair) => pair.early).length} com a reversão enviada antes da BET`,
      ],
    };
  },
};

export const SCENARIOS: readonly Scenario[] = [
  distinctWallets,
  hotWallet,
  replayStorm,
  mixedReversals,
];
