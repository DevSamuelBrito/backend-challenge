import { Logger } from "@nestjs/common";
import type { FaultInjector, FaultPoint } from "../../application/fault-injector.port";

export type KillSelf = () => void;

export const killSelf: KillSelf = () => {
  process.kill(process.pid, "SIGKILL");
  process.abort();
};

export class ProcessKillFaultInjector implements FaultInjector {
  private readonly logger = new Logger(ProcessKillFaultInjector.name);

  constructor(
    private readonly point: FaultPoint,
    private readonly kill: KillSelf = killSelf,
  ) {}

  check(point: FaultPoint): void | Promise<void> {
    if (point !== this.point) {
      return;
    }

    this.logger.error({ event: "fault.crash", point });
    this.kill();

    return new Promise<void>(() => undefined);
  }
}
