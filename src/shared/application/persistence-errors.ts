export class LockTimeoutError extends Error {
  readonly code = "LOCK_TIMEOUT";

  constructor(lockTimeoutMs: number, options?: ErrorOptions) {
    super(`Não foi possível obter o lock em ${lockTimeoutMs}ms`, options);
    this.name = "LockTimeoutError";
  }
}

export class AggregateNotFoundError extends Error {
  readonly code = "AGGREGATE_NOT_FOUND";

  constructor(aggregate: string, id: string) {
    super(`${aggregate} ${id} não existe e não pode ser atualizado`);
    this.name = "AggregateNotFoundError";
  }
}
