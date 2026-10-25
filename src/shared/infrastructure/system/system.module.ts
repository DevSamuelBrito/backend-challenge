import { Module } from "@nestjs/common";
import { CLOCK } from "../../application/clock.port";
import { FAULT_INJECTOR } from "../../application/fault-injector.port";
import { ID_GENERATOR } from "../../application/id-generator.port";
import { NoOpFaultInjector } from "./no-op-fault-injector";
import { SystemClock } from "./system-clock";
import { UuidV7Generator } from "./uuid-v7-generator";

@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: FAULT_INJECTOR, useClass: NoOpFaultInjector },
  ],
  exports: [CLOCK, ID_GENERATOR, FAULT_INJECTOR],
})
export class SystemModule {}
