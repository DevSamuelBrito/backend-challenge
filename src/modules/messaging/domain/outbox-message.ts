import type { IntegrationEvent } from "../../../shared/events/integration-event";
import { OutboxMessageAlreadyPublishedError } from "./messaging-errors";


export const OUTBOX_RETRY_BASE_DELAY_MS = 1_000;
export const OUTBOX_RETRY_MAX_DELAY_MS = 60_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

function retryDelayMs(attempts: number): number {
  return Math.min(OUTBOX_RETRY_MAX_DELAY_MS, OUTBOX_RETRY_BASE_DELAY_MS * 2 ** (attempts - 1));
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      structuredClone(event.toJSON()),
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || now.getTime() >= this._nextAttemptAt.getTime())
    );
  }

  markPublished(at: Date): void {
    this.assertPending();

    this._publishedAt = at;
  }

  scheduleRetry(now: Date): void {
    this.assertPending();

    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + retryDelayMs(this._attempts));
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new OutboxMessageAlreadyPublishedError(this.id);
    }
  }
}
