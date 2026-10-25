export interface LoadSettings {
  rounds: number;
  concurrency: number;
  warmupRequests: number;
  requestTimeoutMs: number;
  drainTimeoutSeconds: number;
  pendingTimeoutSeconds: number;
  minInstances: number;
  distinctWallets: number;
  hotWalletBets: number;
  replayKeys: number;
  replayRequests: number;
  mixedWallets: number;
  mixedPairsPerWallet: number;
  earlyReversalPercent: number;
}

function integer(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} inválido: ${raw} (inteiro entre ${min} e ${max})`);
  }

  return value;
}

export function loadSettings(env: Record<string, string | undefined> = process.env): LoadSettings {
  return {
    rounds: integer(env, "LOAD_ROUNDS", 3, 1, 20),
    concurrency: integer(env, "LOAD_CONCURRENCY", 24, 1, 500),
    warmupRequests: integer(env, "LOAD_WARMUP_REQUESTS", 150, 0),
    requestTimeoutMs: integer(env, "LOAD_REQUEST_TIMEOUT_MS", 15_000, 100),
    drainTimeoutSeconds: integer(env, "LOAD_DRAIN_TIMEOUT_S", 300, 1),
    pendingTimeoutSeconds: integer(env, "LOAD_PENDING_TIMEOUT_S", 90, 1),
    minInstances: integer(env, "LOAD_MIN_INSTANCES", 3, 1, 10),
    distinctWallets: integer(env, "LOAD_WALLETS", 100),
    hotWalletBets: integer(env, "LOAD_HOT_BETS", 600),
    replayKeys: integer(env, "LOAD_REPLAY_KEYS", 5),
    replayRequests: integer(env, "LOAD_REPLAY_REQUESTS", 2000),
    mixedWallets: integer(env, "LOAD_MIXED_WALLETS", 10),
    mixedPairsPerWallet: integer(env, "LOAD_MIXED_PAIRS", 20),
    earlyReversalPercent: integer(env, "LOAD_EARLY_REVERSAL_PERCENT", 30, 0, 100),
  };
}
