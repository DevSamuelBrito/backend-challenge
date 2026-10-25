import { describe, expect, test } from "bun:test";
import { classify } from "../load/client";
import { fromCents, toCents } from "../load/money";
import {
  histogramDelta,
  histogramOf,
  histogramQuantile,
  maxMetric,
  parsePrometheus,
  sumMetric,
} from "../load/prometheus";
import { cell, replaceRegion } from "../load/report";
import { loadSettings } from "../load/settings";
import { median, percentile, spreadOf, summarizeLatency } from "../load/stats";

describe("percentil (nearest-rank)", () => {
  const hundred = Array.from({ length: 100 }, (_, index) => index + 1);

  test("p50, p95 e p99 de 1..100 são 50, 95 e 99", () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });

  test("não depende da ordem de entrada nem muda o array original", () => {
    const shuffled = [5, 1, 4, 2, 3];

    expect(percentile(shuffled, 50)).toBe(3);
    expect(shuffled).toEqual([5, 1, 4, 2, 3]);
  });

  test("com poucas amostras, p99 é o máximo", () => {
    expect(percentile([10, 20, 30], 99)).toBe(30);
    expect(percentile([42], 1)).toBe(42);
  });

  test("sem amostras devolve NaN e percentil inválido é erro", () => {
    expect(percentile([], 50)).toBeNaN();
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });

  test("resumo de latência", () => {
    const summary = summarizeLatency([4, 1, 3, 2]);

    expect(summary).toEqual({ count: 4, min: 1, mean: 2.5, p50: 2, p95: 4, p99: 4, max: 4 });
  });
});

describe("mediana e faixa", () => {
  test("mediana de quantidade ímpar e par", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("faixa ignora NaN", () => {
    expect(spreadOf([5, Number.NaN, 1, 3])).toEqual({ median: 3, min: 1, max: 5 });
    expect(spreadOf([Number.NaN].slice(0, 1)).median).toBeNaN();
  });

  test("célula mostra só o valor quando não há variação", () => {
    expect(cell({ median: 10, min: 10, max: 10 })).toBe("10");
    expect(cell({ median: 10, min: 8, max: 12 })).toBe("10 (8–12)");
  });
});

describe("leitura do formato Prometheus", () => {
  const first = `
# HELP wager_lock_timeouts_total Transações
# TYPE wager_lock_timeouts_total counter
wager_lock_timeouts_total 2
wager_wallet_lock_wait_seconds_bucket{le="0.001"} 1
wager_wallet_lock_wait_seconds_bucket{le="0.01"} 6
wager_wallet_lock_wait_seconds_bucket{le="+Inf"} 10
wager_wallet_lock_wait_seconds_sum 0.5
wager_wallet_lock_wait_seconds_count 10
wager_outbox_lag_seconds 3
wager_processing_duration_seconds_bucket{source="http",le="0.01"} 4
wager_processing_duration_seconds_bucket{source="sqs",le="0.01"} 9
`;
  const second = `
wager_lock_timeouts_total 1
wager_wallet_lock_wait_seconds_bucket{le="0.001"} 0
wager_wallet_lock_wait_seconds_bucket{le="0.01"} 2
wager_wallet_lock_wait_seconds_bucket{le="+Inf"} 5
wager_wallet_lock_wait_seconds_sum 0.25
wager_wallet_lock_wait_seconds_count 5
wager_outbox_lag_seconds 7
`;
  const samples = [...parsePrometheus(first), ...parsePrometheus(second)];

  test("soma contadores entre instâncias e filtra por rótulo", () => {
    expect(sumMetric(samples, "wager_lock_timeouts_total")).toBe(3);
    expect(sumMetric(samples, "wager_processing_duration_seconds_bucket", { source: "http" })).toBe(
      4,
    );
  });

  test("gauge entre instâncias usa o maior valor", () => {
    expect(maxMetric(samples, "wager_outbox_lag_seconds")).toBe(7);
    expect(maxMetric(samples, "nao_existe")).toBe(0);
  });

  test("histograma soma buckets, contagem e soma das instâncias", () => {
    const histogram = histogramOf(samples, "wager_wallet_lock_wait_seconds");

    expect(histogram.count).toBe(15);
    expect(histogram.sum).toBeCloseTo(0.75);
    expect(histogram.buckets.get(0.01)).toBe(8);
    expect(histogram.buckets.get(Number.POSITIVE_INFINITY)).toBe(15);
  });

  test("quantil devolve o limite superior do bucket e infinito acima do último finito", () => {
    const histogram = histogramOf(samples, "wager_wallet_lock_wait_seconds");

    expect(histogramQuantile(histogram, 0.05)).toBe(0.001);
    expect(histogramQuantile(histogram, 0.5)).toBe(0.01);
    expect(histogramQuantile(histogram, 0.99)).toBe(Number.POSITIVE_INFINITY);
  });

  test("diferença entre duas leituras isola o que aconteceu no cenário", () => {
    const before = histogramOf(parsePrometheus(first), "wager_wallet_lock_wait_seconds");
    const after = histogramOf(samples, "wager_wallet_lock_wait_seconds");
    const delta = histogramDelta(after, before);

    expect(delta.count).toBe(5);
    expect(delta.sum).toBeCloseTo(0.25);
    expect(delta.buckets.get(0.01)).toBe(2);
  });

  test("sem observações o quantil é NaN", () => {
    const empty = histogramOf([], "wager_wallet_lock_wait_seconds");

    expect(histogramQuantile(empty, 0.5)).toBeNaN();
  });
});

describe("dinheiro do gerador de carga", () => {
  test("converte de e para centavos sem usar ponto flutuante", () => {
    expect(toCents("1000000.00")).toBe(100_000_000n);
    expect(toCents("2.50")).toBe(250n);
    expect(fromCents(5n)).toBe("0.05");
    expect(fromCents(toCents("1010.00"))).toBe("1010.00");
  });

  test("recusa formatos inválidos", () => {
    expect(() => toCents("10")).toThrow();
    expect(() => toCents("10.5")).toThrow();
    expect(() => fromCents(-1n)).toThrow();
  });
});

describe("classificação das respostas", () => {
  test("separa rejeição de negócio de erro técnico", () => {
    expect(classify(200)).toBe("ok");
    expect(classify(202)).toBe("pending");
    expect(classify(409)).toBe("conflict");
    expect(classify(422)).toBe("business");
    expect(classify(503)).toBe("lock_timeout");
    expect(classify(500)).toBe("server_error");
    expect(classify(0)).toBe("network");
    expect(classify(400)).toBe("client_error");
  });
});

describe("configuração do teste de carga", () => {
  test("padrões e validação", () => {
    expect(loadSettings({}).rounds).toBe(3);
    expect(loadSettings({}).concurrency).toBe(24);
    expect(loadSettings({ LOAD_ROUNDS: "1" }).rounds).toBe(1);
    expect(() => loadSettings({ LOAD_CONCURRENCY: "0" })).toThrow();
    expect(() => loadSettings({ LOAD_EARLY_REVERSAL_PERCENT: "101" })).toThrow();
  });
});

describe("regiões do relatório", () => {
  const document =
    "# T\n\ntexto manual\n\n<!-- load:results:start -->\nvelho\n<!-- load:results:end -->\n\nrodapé\n";

  test("troca só o conteúdo entre os marcadores e preserva o texto manual", () => {
    const updated = replaceRegion(document, "results", "novo");

    expect(updated).toContain("texto manual");
    expect(updated).toContain("rodapé");
    expect(updated).toContain("<!-- load:results:start -->\nnovo\n<!-- load:results:end -->");
    expect(updated).not.toContain("velho");
  });

  test("acrescenta a região no fim quando o marcador não existe", () => {
    const updated = replaceRegion("# T\n", "environment", "ambiente");

    expect(updated).toBe(
      "# T\n\n<!-- load:environment:start -->\nambiente\n<!-- load:environment:end -->\n",
    );
  });
});
