import { describe, expect, test } from "bun:test";
import {
  eventPropsFrom,
  IntegrationEvent,
  type IntegrationEventProps,
} from "../../src/shared/events/integration-event";
import { aContext } from "../support/wagering-builders";

interface PingData {
  note: string;
}

class PingEvent extends IntegrationEvent<PingData> {
  readonly eventType = "PingEvent";
  readonly version = 3;

  private constructor(props: IntegrationEventProps<PingData>) {
    super(props);
  }

  static of(aggregateId: string, context = aContext()): PingEvent {
    return new PingEvent(eventPropsFrom(aggregateId, context, { note: "ola" }));
  }
}

describe("IntegrationEvent: envelope", () => {
  test("toJSON devolve o envelope completo com occurredAt em ISO-8601", () => {
    const event = PingEvent.of("agg-1");

    expect(event.toJSON()).toEqual({
      eventId: "evt-1",
      eventType: "PingEvent",
      aggregateId: "agg-1",
      correlationId: "corr-1",
      causationId: "cause-1",
      occurredAt: "2026-01-01T12:00:00.000Z",
      version: 3,
      data: { note: "ola" },
    });
  });

  test("o envelope tem exatamente as chaves esperadas", () => {
    expect(Object.keys(PingEvent.of("agg-1").toJSON()).sort()).toEqual(
      [
        "aggregateId",
        "causationId",
        "correlationId",
        "data",
        "eventId",
        "eventType",
        "occurredAt",
        "version",
      ].sort(),
    );
  });

  test("causationId ausente não aparece no envelope", () => {
    const event = PingEvent.of("agg-1", aContext({ causationId: undefined }));
    const json = event.toJSON();

    expect("causationId" in json).toBe(false);
    expect(event.causationId).toBeUndefined();
    expect(JSON.parse(JSON.stringify(event))).not.toHaveProperty("causationId");
  });

  test("occurredAt vira string ISO e continua um Date no evento", () => {
    const event = PingEvent.of("agg-1");

    expect(event.occurredAt).toBeInstanceOf(Date);
    expect(typeof event.toJSON().occurredAt).toBe("string");
    expect(new Date(event.toJSON().occurredAt).getTime()).toBe(event.occurredAt.getTime());
  });

  test("JSON.stringify usa toJSON e a volta preserva o conteúdo", () => {
    const event = PingEvent.of("agg-1");

    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  test("eventType e version vêm da subclasse", () => {
    const event = PingEvent.of("agg-1");

    expect(event.eventType).toBe("PingEvent");
    expect(event.version).toBe(3);
  });

  test("eventPropsFrom copia os campos do contexto", () => {
    const context = aContext();

    expect(eventPropsFrom("agg-9", context, { note: "x" })).toEqual({
      eventId: context.eventId,
      aggregateId: "agg-9",
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: context.occurredAt,
      data: { note: "x" },
    });
  });
});
