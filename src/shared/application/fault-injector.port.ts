export const FAULT_INJECTOR = Symbol("FAULT_INJECTOR");

export const FAULT_POINTS = [
  "outbox.after_send_before_mark",
  "consumer.after_commit_before_ack",
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface FaultInjector {
  check(point: FaultPoint): void | Promise<void>;
}
