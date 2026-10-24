import { UniqueConstraintViolationException } from "@mikro-orm/core";

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof UniqueConstraintViolationException &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}
