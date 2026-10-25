import type { Clock } from "../../src/shared/application/clock.port";
import type { IdGenerator } from "../../src/shared/application/id-generator.port";

export class FixedClock implements Clock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    return new Date(this.instant.getTime());
  }
}

export class ControlledClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(instant: Date): void {
    this.current = new Date(instant.getTime());
  }

  advance(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
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
