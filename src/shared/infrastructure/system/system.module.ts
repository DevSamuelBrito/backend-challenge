import { Module } from "@nestjs/common";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env";
import { CLOCK } from "../../application/clock.port";
import { FAULT_INJECTOR } from "../../application/fault-injector.port";
import { ID_GENERATOR } from "../../application/id-generator.port";
import { NoOpFaultInjector } from "./no-op-fault-injector";
import { ProcessKillFaultInjector } from "./process-kill-fault-injector";
import { SystemClock } from "./system-clock";
import { UuidV7Generator } from "./uuid-v7-generator";

@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    {
      provide: FAULT_INJECTOR,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.faultInjection.point
          ? new ProcessKillFaultInjector(config.faultInjection.point)
          : new NoOpFaultInjector(),
    },
  ],
  exports: [CLOCK, ID_GENERATOR, FAULT_INJECTOR],
})
export class SystemModule {}
