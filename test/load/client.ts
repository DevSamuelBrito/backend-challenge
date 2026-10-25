import type { Instance } from "./cluster";

export interface Sample {
  op: string;
  status: number;
  ms: number;
  replay: boolean;
  txStatus?: string;
  failureCode?: string;
  transactionId?: string;
}

export interface TransactionRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

interface TransactionReply {
  transactionId?: string;
  status?: string;
  failureCode?: string;
  idempotentReplay?: boolean;
}

export type Outcome =
  | "ok"
  | "pending"
  | "business"
  | "conflict"
  | "lock_timeout"
  | "server_error"
  | "client_error"
  | "network";

export function classify(status: number): Outcome {
  if (status === 0) return "network";
  if (status === 202) return "pending";
  if (status >= 200 && status < 300) return "ok";
  if (status === 409) return "conflict";
  if (status === 422) return "business";
  if (status === 503) return "lock_timeout";
  if (status >= 500) return "server_error";
  return "client_error";
}

export class LoadClient {
  private cursor = 0;

  constructor(
    private readonly instances: readonly Instance[],
    private readonly timeoutMs: number,
  ) {}

  private nextInstance(): Instance {
    const instance = this.instances[this.cursor % this.instances.length] as Instance;
    this.cursor += 1;

    return instance;
  }

  async transaction(
    op: string,
    request: TransactionRequest,
    idempotencyKey?: string,
  ): Promise<Sample> {
    const key = idempotencyKey ?? `${request.providerId}:${request.externalTransactionId}`;
    const startedAt = performance.now();

    try {
      const reply = await fetch(`${this.nextInstance().base}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await reply.text();
      const ms = performance.now() - startedAt;
      const body = parseReply(text);

      return {
        op,
        status: reply.status,
        ms,
        replay: body.idempotentReplay === true,
        txStatus: body.status,
        failureCode: body.failureCode,
        transactionId: body.transactionId,
      };
    } catch {
      return { op, status: 0, ms: performance.now() - startedAt, replay: false };
    }
  }

  async createWallet(playerId: string, amount: string, currency = "BRL"): Promise<string> {
    const reply = await fetch(`${this.nextInstance().base}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await reply.json()) as { id?: string };

    if (reply.status !== 201 || !body.id) {
      throw new Error(
        `criação da wallet ${playerId} falhou: HTTP ${reply.status} ${JSON.stringify(body)}`,
      );
    }

    return body.id;
  }

  async reconcile(walletId: string): Promise<{ consistent: boolean; detail: string }> {
    const reply = await fetch(`${this.nextInstance().base}/wallets/${walletId}/reconciliation`, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await reply.json()) as {
      consistent?: boolean;
      storedBalance?: { amount: string };
      calculatedBalance?: { amount: string };
    };

    return {
      consistent: reply.status === 200 && body.consistent === true,
      detail: `HTTP ${reply.status} guardado=${body.storedBalance?.amount} recalculado=${body.calculatedBalance?.amount}`,
    };
  }
}

function parseReply(text: string): TransactionReply {
  try {
    return JSON.parse(text) as TransactionReply;
  } catch {
    return {};
  }
}
