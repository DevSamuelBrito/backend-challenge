export const FAULT_INJECTOR = Symbol("FAULT_INJECTOR");

export type FaultPoint = "outbox.after_send_before_mark" | "consumer.after_commit_before_ack";

export interface FaultInjector {
  check(point: FaultPoint): void | Promise<void>;
}
