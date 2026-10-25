const SENSITIVE_KEYS = [
  "money",
  "amount",
  "balance",
  "storedBalance",
  "calculatedBalance",
  "difference",
  "idempotencyKey",
  "body",
  "payload",
  "headers",
  "authorization",
];

export const REDACT_PATHS: string[] = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
  'req.headers["idempotency-key"]',
  'headers["idempotency-key"]',
];

export const REDACT_CENSOR = "[REDACTED]";
