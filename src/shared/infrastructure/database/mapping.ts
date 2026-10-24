import { Money } from "../../domain/money";

export class CorruptedRecordError extends Error {
  readonly code = "CORRUPTED_RECORD";

  constructor(column: string, value: unknown) {
    super(`Valor inesperado na coluna ${column}: ${String(value)}`);
    this.name = "CorruptedRecordError";
  }
}

export function moneyFromColumn(amount: string, currency: string): Money {
  return Money.from({ amount, currency });
}

export function moneyToColumn(money: Money): string {
  return money.toJSON().amount;
}

export function parseEnum<T extends string>(
  values: Readonly<Record<string, T>>,
  column: string,
  raw: string,
): T {
  const found = Object.values(values).find((value) => value === raw);

  if (found === undefined) {
    throw new CorruptedRecordError(column, raw);
  }

  return found;
}
