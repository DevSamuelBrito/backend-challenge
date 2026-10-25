export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface HistogramSnapshot {
  buckets: Map<number, number>;
  count: number;
  sum: number;
}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+\S+)?$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

function parseValue(raw: string): number {
  switch (raw) {
    case "+Inf":
    case "Inf":
      return Number.POSITIVE_INFINITY;
    case "-Inf":
      return Number.NEGATIVE_INFINITY;
    default:
      return Number(raw);
  }
}

export function parsePrometheus(text: string): MetricSample[] {
  const samples: MetricSample[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const match = LINE.exec(line);

    if (!match) {
      continue;
    }

    const labels: Record<string, string> = {};

    for (const label of (match[2] ?? "").matchAll(LABEL)) {
      labels[label[1] as string] = label[2] as string;
    }

    samples.push({ name: match[1] as string, labels, value: parseValue(match[3] as string) });
  }

  return samples;
}

function matches(sample: MetricSample, filter: Record<string, string>): boolean {
  return Object.entries(filter).every(([key, value]) => sample.labels[key] === value);
}

export function sumMetric(
  samples: readonly MetricSample[],
  name: string,
  filter: Record<string, string> = {},
): number {
  return samples
    .filter((sample) => sample.name === name && matches(sample, filter))
    .reduce((total, sample) => total + sample.value, 0);
}

export function maxMetric(samples: readonly MetricSample[], name: string): number {
  const values = samples.filter((sample) => sample.name === name).map((sample) => sample.value);

  return values.length === 0 ? 0 : Math.max(...values);
}

export function histogramOf(
  samples: readonly MetricSample[],
  baseName: string,
  filter: Record<string, string> = {},
): HistogramSnapshot {
  const buckets = new Map<number, number>();

  for (const sample of samples) {
    if (sample.name !== `${baseName}_bucket` || !matches(sample, filter)) {
      continue;
    }

    const le = parseValue(sample.labels.le ?? "NaN");
    buckets.set(le, (buckets.get(le) ?? 0) + sample.value);
  }

  return {
    buckets,
    count: sumMetric(samples, `${baseName}_count`, filter),
    sum: sumMetric(samples, `${baseName}_sum`, filter),
  };
}

export function histogramDelta(
  after: HistogramSnapshot,
  before: HistogramSnapshot,
): HistogramSnapshot {
  const buckets = new Map<number, number>();

  for (const [le, value] of after.buckets) {
    buckets.set(le, value - (before.buckets.get(le) ?? 0));
  }

  return { buckets, count: after.count - before.count, sum: after.sum - before.sum };
}

export function histogramQuantile(histogram: HistogramSnapshot, quantile: number): number {
  if (histogram.count <= 0) {
    return Number.NaN;
  }

  const target = quantile * histogram.count;
  const ordered = [...histogram.buckets.entries()].sort(([a], [b]) => a - b);

  for (const [le, cumulative] of ordered) {
    if (cumulative >= target) {
      return le;
    }
  }

  return Number.POSITIVE_INFINITY;
}
