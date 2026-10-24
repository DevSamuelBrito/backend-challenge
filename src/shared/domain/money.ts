import { DomainError } from "./domain-error";

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "MONEY_CURRENCY_MISMATCH";

  constructor(left: string, right: string) {
    super(`Operação entre moedas diferentes: ${left} e ${right}`);
  }
}

const AMOUNT_PATTERN = /^\d+\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CENTS_PER_UNIT = 100n;
const MAX_CENTS = 10n ** 20n - 1n;

function assertCurrency(currency: unknown): asserts currency is string {
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError(`Moeda inválida: ${String(currency)}`);
  }
}

function formatCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  const fraction = (absolute % CENTS_PER_UNIT).toString().padStart(2, "0");

  return `${sign}${absolute / CENTS_PER_UNIT}.${fraction}`;
}

export class MoneyOutOfRangeError extends DomainError {
  readonly code = "MONEY_OUT_OF_RANGE";

  constructor() {
    super(`Valor monetário fora do limite de ±${formatCents(MAX_CENTS)}`);
  }
}

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    if (cents > MAX_CENTS || cents < -MAX_CENTS) {
      throw new MoneyOutOfRangeError();
    }

    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`Valor monetário inválido: ${String(amount)}`);
    }

    assertCurrency(currency);

    return new Money(BigInt(amount.replace(".", "")), currency);
  }

  static zero(currency: string): Money {
    assertCurrency(currency);

    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: formatCents(this.cents), currency: this.currency };
  }

  toString(): string {
    return `${formatCents(this.cents)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
