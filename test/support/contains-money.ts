import { Money } from "../../src/shared/domain/money";

export function containsMoneyInstance(value: unknown): boolean {
  if (value instanceof Money) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some(containsMoneyInstance);
  }

  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsMoneyInstance);
  }

  return false;
}
