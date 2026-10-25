const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function validCorrelationId(candidate: unknown): string | undefined {
  return typeof candidate === "string" && CORRELATION_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}
