import type { Clock } from "../../src/shared/application/clock.port";
import type { IdGenerator } from "../../src/shared/application/id-generator.port";

export class FixedClock implements Clock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    return new Date(this.instant.getTime());
  }
}

export class SequentialIdGenerator implements IdGenerator {
  readonly issued: string[] = [];

  next(): string {
    const id = `00000000-0000-7000-8000-${String(this.issued.length + 1).padStart(12, "0")}`;
    this.issued.push(id);
    return id;
  }
}
