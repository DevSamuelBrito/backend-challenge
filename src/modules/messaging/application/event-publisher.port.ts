export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");

export interface OutboundEvent {
  eventId: string;
  eventType: string;
  groupId: string;
  body: string;
}

export type PublishOutcome =
  | { eventId: string; confirmed: true }
  | { eventId: string; confirmed: false; reason: string };

export interface EventPublisher {
  publish(events: readonly OutboundEvent[]): Promise<PublishOutcome[]>;
}
