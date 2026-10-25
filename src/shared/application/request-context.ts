import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, work: () => T): T {
  return storage.run(context, work);
}

export function currentContext(): Readonly<RequestContext> {
  return storage.getStore() ?? {};
}

export function enrichContext(fields: RequestContext): void {
  const store = storage.getStore();

  if (!store) {
    return;
  }

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      store[key as keyof RequestContext] = value;
    }
  }
}
