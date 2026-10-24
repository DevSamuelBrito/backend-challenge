import type { Clock } from "../../application/clock.port";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
