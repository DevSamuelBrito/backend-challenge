import type { IdGenerator } from "../../application/id-generator.port";

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
