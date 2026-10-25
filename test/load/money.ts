const MONEY = /^(\d+)\.(\d{2})$/;

export function toCents(amount: string): bigint {
  const match = MONEY.exec(amount);

  if (!match) {
    throw new Error(`valor monetário inválido: ${amount}`);
  }

  return BigInt(match[1] as string) * 100n + BigInt(match[2] as string);
}

export function fromCents(cents: bigint): string {
  if (cents < 0n) {
    throw new Error(`valor negativo: ${cents}`);
  }

  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
