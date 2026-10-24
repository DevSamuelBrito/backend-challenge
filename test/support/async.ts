import type { Client } from "pg";

export interface Gate {
  opened: Promise<void>;
  open(): void;
}

export function createGate(): Gate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { opened, open };
}

export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Tempo esgotado esperando: ${description}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function countBackendsWaitingOnLock(client: Client): Promise<number> {
  const { rows } = await client.query(
    `select count(*)::int as waiting
       from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and wait_event_type = 'Lock'`,
  );

  return rows[0].waiting as number;
}

export function waitUntilSomeoneWaitsOnLock(client: Client, expected = 1): Promise<void> {
  return waitUntil(
    async () => (await countBackendsWaitingOnLock(client)) >= expected,
    `${expected} conexão(ões) esperando por lock no Postgres`,
  );
}
