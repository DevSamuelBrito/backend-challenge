export async function runClosedLoop<T>(
  concurrency: number,
  items: readonly T[],
  work: (item: T, index: number) => Promise<void>,
): Promise<number> {
  let cursor = 0;
  const startedAt = performance.now();

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= items.length) {
        return;
      }

      await work(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

  return performance.now() - startedAt;
}

export const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
