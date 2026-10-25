import type { FaultInjector } from "../../application/fault-injector.port";

export class NoOpFaultInjector implements FaultInjector {
  check(): void {}
}
