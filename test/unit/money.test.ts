import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/shared/domain/domain-error";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
  MoneyOutOfRangeError,
  type MoneyProps,
} from "../../src/shared/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

const MAX_AMOUNT = "999999999999999999.99";
const JUST_ABOVE_MAX_AMOUNT = "1000000000000000000.00";

describe("Money.from: entradas válidas", () => {
  test.each([
    ["25.00", "25.00"],
    ["0.00", "0.00"],
    ["0.01", "0.01"],
    ["0.10", "0.10"],
    ["1000000.00", "1000000.00"],
    ["007.50", "7.50"],
  ])("aceita %s e serializa como %s", (input, expected) => {
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: "BRL" });
  });

  test("aceita valores acima de Number.MAX_SAFE_INTEGER sem perder precisão", () => {
    expect(brl("9007199254740993.01").toJSON().amount).toBe("9007199254740993.01");
  });
});

describe("Money.from: entradas inválidas (nunca arredonda)", () => {
  test.each([
    [""],
    ["25"],
    ["25."],
    [".50"],
    ["25.5"],
    ["25.0"],
    ["1.555"],
    ["1.005"],
    ["0.001"],
    ["10.999"],
    ["1e3"],
    ["1.00e3"],
    ["NaN"],
    ["Infinity"],
    ["-Infinity"],
    ["+25.00"],
    ["-25.00"],
    ["-0.00"],
    [" 25.00"],
    ["25.00 "],
    ["25,00"],
    ["1_000.00"],
    ["0x10.00"],
    ["٢٥.٠٠"],
  ])("rejeita %p", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejeita amount que não é string", () => {
    for (const amount of [25, 25.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, 25n]) {
      const props = { amount, currency: "BRL" } as unknown as MoneyProps;

      expect(() => Money.from(props)).toThrow(InvalidMoneyError);
    }
  });

  test.each([[""], ["brl"], ["BR"], ["BRLL"], ["R$"], ["B1L"], [" BRL"]])(
    "rejeita a moeda %p",
    (currency) => {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
    },
  );

  test("rejeita moeda que não é string", () => {
    const props = { amount: "1.00", currency: 986 } as unknown as MoneyProps;

    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  test("o erro é um erro de domínio com código estável", () => {
    try {
      brl("1.555");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as InvalidMoneyError).code).toBe("INVALID_MONEY");
    }
  });
});

describe("Money: limite de 18 dígitos antes da vírgula (numeric(20,2))", () => {
  test("Money.from aceita exatamente o maior valor", () => {
    expect(brl(MAX_AMOUNT).toJSON()).toEqual({ amount: MAX_AMOUNT, currency: "BRL" });
  });

  test("Money.from rejeita um centavo acima do limite", () => {
    expect(() => brl(JUST_ABOVE_MAX_AMOUNT)).toThrow(MoneyOutOfRangeError);
  });

  test.each([["1000000000000000000.01"], ["99999999999999999999999999999.99"]])(
    "Money.from rejeita %s",
    (amount) => {
      expect(() => brl(amount)).toThrow(MoneyOutOfRangeError);
    },
  );

  test("o erro é de domínio, tem código estável e informa o limite", () => {
    try {
      brl(JUST_ABOVE_MAX_AMOUNT);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as MoneyOutOfRangeError).code).toBe("MONEY_OUT_OF_RANGE");
      expect((error as MoneyOutOfRangeError).message).toContain(MAX_AMOUNT);
    }
  });

  test("add: chegar exatamente no limite é aceito, passar um centavo é rejeitado", () => {
    expect(brl("999999999999999999.98").add(brl("0.01")).toJSON().amount).toBe(MAX_AMOUNT);
    expect(brl(MAX_AMOUNT).add(Money.zero("BRL")).toJSON().amount).toBe(MAX_AMOUNT);
    expect(() => brl(MAX_AMOUNT).add(brl("0.01"))).toThrow(MoneyOutOfRangeError);
    expect(() => brl("500000000000000000.00").add(brl("500000000000000000.00"))).toThrow(
      MoneyOutOfRangeError,
    );
  });

  test("add: o limite vale também para o lado negativo", () => {
    const negativeMax = brl(MAX_AMOUNT).negate();

    expect(() => negativeMax.add(brl("0.01").negate())).toThrow(MoneyOutOfRangeError);
    expect(negativeMax.add(brl(MAX_AMOUNT)).isZero()).toBe(true);
  });

  test("subtract: nos extremos, aceita o limite e rejeita um centavo além", () => {
    const zero = Money.zero("BRL");

    expect(zero.subtract(brl(MAX_AMOUNT)).toJSON().amount).toBe(`-${MAX_AMOUNT}`);
    expect(brl(MAX_AMOUNT).subtract(zero).toJSON().amount).toBe(MAX_AMOUNT);
    expect(brl(MAX_AMOUNT).subtract(brl(MAX_AMOUNT)).isZero()).toBe(true);
    expect(() => zero.subtract(brl(MAX_AMOUNT)).subtract(brl("0.01"))).toThrow(
      MoneyOutOfRangeError,
    );
    expect(() => brl(MAX_AMOUNT).subtract(brl("0.01").negate())).toThrow(MoneyOutOfRangeError);
    expect(() => brl(MAX_AMOUNT).subtract(brl(MAX_AMOUNT).negate())).toThrow(MoneyOutOfRangeError);
  });

  test("negate: o limite é simétrico, então negar nos extremos nunca estoura", () => {
    const max = brl(MAX_AMOUNT);
    const negativeMax = max.negate();

    expect(negativeMax.toJSON().amount).toBe(`-${MAX_AMOUNT}`);
    expect(negativeMax.negate().equals(max)).toBe(true);
  });

  test("uma operação que estoura não altera os operandos", () => {
    const max = brl(MAX_AMOUNT);
    const one = brl("0.01");

    expect(() => max.add(one)).toThrow(MoneyOutOfRangeError);
    expect(max.toJSON().amount).toBe(MAX_AMOUNT);
    expect(one.toJSON().amount).toBe("0.01");
  });

  test("a checagem de moeda vem antes da de limite", () => {
    expect(() => brl(MAX_AMOUNT).add(usd("0.01"))).toThrow(CurrencyMismatchError);
  });
});

describe("Money.zero", () => {
  test("cria um Money zerado na moeda informada", () => {
    const zero = Money.zero("BRL");

    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
  });

  test("Money.from aceita zero, a rejeição de zero é regra das operações", () => {
    expect(brl("0.00").isZero()).toBe(true);
    expect(brl("0.00").equals(Money.zero("BRL"))).toBe(true);
  });

  test("rejeita moeda inválida", () => {
    expect(() => Money.zero("brl")).toThrow(InvalidMoneyError);
    expect(() => Money.zero("")).toThrow(InvalidMoneyError);
  });
});

describe("Money: aritmética exata", () => {
  test("add: 0.10 + 0.20 = 0.30 (o que o number erra)", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("add: soma com vai-um entre centavos e unidades", () => {
    expect(brl("0.99").add(brl("0.01")).toJSON().amount).toBe("1.00");
    expect(brl("19.99").add(brl("19.99")).toJSON().amount).toBe("39.98");
  });

  test("add: preserva precisão acima de Number.MAX_SAFE_INTEGER", () => {
    const result = brl("9007199254740993.01").add(brl("0.01"));

    expect(result.toJSON().amount).toBe("9007199254740993.02");
  });

  test("subtract: resultado positivo, zero e negativo", () => {
    expect(brl("100.00").subtract(brl("80.00")).toJSON().amount).toBe("20.00");
    expect(brl("80.00").subtract(brl("80.00")).isZero()).toBe(true);

    const negative = brl("20.00").subtract(brl("80.00"));

    expect(negative.isNegative()).toBe(true);
    expect(negative.toJSON().amount).toBe("-60.00");
  });

  test("subtract: 0.30 - 0.10 = 0.20", () => {
    expect(brl("0.30").subtract(brl("0.10")).toJSON().amount).toBe("0.20");
  });

  test("negate: inverte o sinal e negar duas vezes volta ao original", () => {
    const value = brl("25.00");

    expect(value.negate().toJSON().amount).toBe("-25.00");
    expect(value.negate().isNegative()).toBe(true);
    expect(value.negate().negate().equals(value)).toBe(true);
  });

  test("negate de zero continua zero e sem sinal", () => {
    const zero = Money.zero("BRL").negate();

    expect(zero.isZero()).toBe(true);
    expect(zero.isNegative()).toBe(false);
    expect(zero.toJSON().amount).toBe("0.00");
  });

  test("um valor negativo calculado não volta a ser aceito como entrada", () => {
    const negative = brl("20.00").subtract(brl("80.00")).toJSON();

    expect(() => Money.from(negative)).toThrow(InvalidMoneyError);
  });
});

describe("Money: sinal e comparação", () => {
  test("isZero, isPositive e isNegative", () => {
    expect(brl("0.00").isZero()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("0.00").isNegative()).toBe(false);

    expect(brl("0.01").isZero()).toBe(false);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").isNegative()).toBe(false);

    const negative = brl("0.01").negate();

    expect(negative.isZero()).toBe(false);
    expect(negative.isPositive()).toBe(false);
    expect(negative.isNegative()).toBe(true);
  });

  test("isPositive é o que as operações usam para rejeitar valor zero", () => {
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("0.01").isPositive()).toBe(true);
  });

  test("isLessThan compara valores, inclusive negativos", () => {
    expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
    expect(brl("80.01").isLessThan(brl("80.00"))).toBe(false);
    expect(brl("1.00").negate().isLessThan(brl("0.00"))).toBe(true);
  });

  test("equals compara valor e moeda", () => {
    expect(brl("25.00").equals(brl("25.00"))).toBe(true);
    expect(brl("25.00").equals(brl("25.01"))).toBe(false);
    expect(brl("25.00").equals(usd("25.00"))).toBe(false);
    expect(brl("007.50").equals(brl("7.50"))).toBe(true);
  });
});

describe("Money: conflito de moeda", () => {
  test("add, subtract e isLessThan lançam erro de domínio", () => {
    expect(() => brl("1.00").add(usd("1.00"))).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd("1.00"))).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd("1.00"))).toThrow(CurrencyMismatchError);
  });

  test("o erro é de domínio, tem código estável e cita as duas moedas", () => {
    try {
      brl("1.00").add(usd("1.00"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as CurrencyMismatchError).code).toBe("MONEY_CURRENCY_MISMATCH");
      expect((error as CurrencyMismatchError).message).toContain("BRL");
      expect((error as CurrencyMismatchError).message).toContain("USD");
    }
  });

  test("a operação que falha não altera nenhum dos operandos", () => {
    const left = brl("1.00");
    const right = usd("2.00");

    expect(() => left.add(right)).toThrow();
    expect(left.toJSON()).toEqual({ amount: "1.00", currency: "BRL" });
    expect(right.toJSON()).toEqual({ amount: "2.00", currency: "USD" });
  });
});

describe("Money: imutabilidade", () => {
  test("cada operação devolve uma nova instância e preserva a original", () => {
    const original = brl("10.00");
    const other = brl("3.00");

    const sum = original.add(other);
    const difference = original.subtract(other);
    const negated = original.negate();

    for (const result of [sum, difference, negated]) {
      expect(result).not.toBe(original);
    }
    expect(original.toJSON().amount).toBe("10.00");
    expect(other.toJSON().amount).toBe("3.00");
    expect(sum.toJSON().amount).toBe("13.00");
    expect(difference.toJSON().amount).toBe("7.00");
    expect(negated.toJSON().amount).toBe("-10.00");
  });

  test("a instância é congelada: não dá para trocar a moeda nem o valor interno", () => {
    const money = brl("10.00");
    const tampered = money as unknown as { currency: string; cents: bigint };

    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      tampered.currency = "USD";
    }).toThrow(TypeError);
    expect(() => {
      tampered.cents = 1n;
    }).toThrow(TypeError);
    expect(money.toJSON()).toEqual({ amount: "10.00", currency: "BRL" });
  });

  test("mutar o objeto devolvido por toJSON não afeta o Money", () => {
    const money = brl("10.00");
    const json = money.toJSON();

    json.amount = "999.00";
    json.currency = "USD";

    expect(money.toJSON()).toEqual({ amount: "10.00", currency: "BRL" });
  });

  test("Money.zero devolve instâncias independentes", () => {
    expect(Money.zero("BRL")).not.toBe(Money.zero("BRL"));
  });
});

describe("Money: serialização", () => {
  test("toJSON devolve { amount: string, currency }", () => {
    const json = brl("25.00").toJSON();

    expect(json).toEqual({ amount: "25.00", currency: "BRL" });
    expect(typeof json.amount).toBe("string");
  });

  test("JSON.stringify usa toJSON", () => {
    expect(JSON.stringify({ money: brl("25.00") })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
  });

  test("toString mostra valor e moeda", () => {
    expect(brl("25.00").toString()).toBe("25.00 BRL");
    expect(`${brl("0.05")}`).toBe("0.05 BRL");
    expect(brl("1.00").negate().toString()).toBe("-1.00 BRL");
  });

  test("ida e volta: from(toJSON()) reconstrói um Money igual", () => {
    for (const amount of ["0.00", "0.01", "25.00", "123456789.99"]) {
      const original = brl(amount);

      expect(Money.from(original.toJSON()).equals(original)).toBe(true);
    }
  });
});
