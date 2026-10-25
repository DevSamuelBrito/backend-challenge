export interface LatencySummary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface Spread {
  median: number;
  min: number;
  max: number;
}

export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) {
    return Number.NaN;
  }

  if (p < 0 || p > 100) {
    throw new RangeError(`percentil fora de 0..100: ${p}`);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));

  return sorted[rank - 1] as number;
}

export function summarizeLatency(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return {
      count: 0,
      min: Number.NaN,
      mean: Number.NaN,
      p50: Number.NaN,
      p95: Number.NaN,
      p99: Number.NaN,
      max: Number.NaN,
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1] as number;
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    count: sorted.length,
    min: sorted[0] as number,
    mean: total / sorted.length,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: sorted[sorted.length - 1] as number,
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function spreadOf(values: readonly number[]): Spread {
  const finite = values.filter((value) => !Number.isNaN(value));

  if (finite.length === 0) {
    return { median: Number.NaN, min: Number.NaN, max: Number.NaN };
  }

  return { median: median(finite), min: Math.min(...finite), max: Math.max(...finite) };
}
