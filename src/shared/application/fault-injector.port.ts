export const FAULT_INJECTOR = Symbol("FAULT_INJECTOR");

export type FaultPoint = "outbox.after_send_before_mark";

export interface FaultInjector {
  check(point: FaultPoint): void | Promise<void>;
}
