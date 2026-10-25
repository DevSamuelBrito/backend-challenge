export interface VisibilityBackoff {
  baseSeconds: number;
  maxSeconds: number;
}

export function visibilityBackoffSeconds(receiveCount: number, backoff: VisibilityBackoff): number {
  const retry = Math.max(receiveCount, 1);

  return Math.min(2 ** (retry - 1) * backoff.baseSeconds, backoff.maxSeconds);
}
