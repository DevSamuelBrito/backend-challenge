import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  FAULT_INJECTOR,
  type FaultInjector,
} from "../../../shared/application/fault-injector.port";
import { UNIT_OF_WORK, type UnitOfWork } from "../../../shared/application/unit-of-work.port";
import type { OutboxMessage } from "../domain/outbox-message";
import {
  EVENT_PUBLISHER,
  type EventPublisher,
  type OutboundEvent,
  type PublishOutcome,
} from "./event-publisher.port";

export const OUTBOX_SETTINGS = Symbol("OUTBOX_SETTINGS");

export interface OutboxSettings {
  batchSize: number;
  alertAttempts: number;
}

export interface OutboxTickReport {
  claimed: number;
  published: number;
  failed: number;
}

@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(FAULT_INJECTOR) private readonly faults: FaultInjector,
    @Inject(OUTBOX_SETTINGS) private readonly settings: OutboxSettings,
  ) {}

  tick(now: Date): Promise<OutboxTickReport> {
    return this.unitOfWork.run(async ({ outbox }) => {
      const batch = await outbox.lockDueBatch(now, this.settings.batchSize);

      if (batch.length === 0) {
        return { claimed: 0, published: 0, failed: 0 };
      }

      const outcomes = await this.send(batch);

      await this.faults.check("outbox.after_send_before_mark");

      const report: OutboxTickReport = { claimed: batch.length, published: 0, failed: 0 };

      for (const message of batch) {
        const outcome = outcomes.get(message.id);

        if (outcome?.confirmed) {
          message.markPublished(now);
          report.published += 1;
        } else {
          message.scheduleRetry(now);
          report.failed += 1;
          this.warnIfLate(message, outcome?.reason ?? "sem confirmação do SQS");
        }

        await outbox.save(message);
      }

      return report;
    });
  }

  private async send(batch: readonly OutboxMessage[]): Promise<Map<string, PublishOutcome>> {
    const outcomes = new Map<string, PublishOutcome>();
    const outbound: OutboundEvent[] = [];

    for (const message of batch) {
      const groupId = walletIdOf(message);

      if (groupId === undefined) {
        outcomes.set(message.id, {
          eventId: message.id,
          confirmed: false,
          reason: "evento sem data.walletId para o MessageGroupId",
        });
        continue;
      }

      outbound.push({
        eventId: message.id,
        eventType: message.eventType,
        groupId,
        body: JSON.stringify(message.payload),
      });
    }

    if (outbound.length === 0) {
      return outcomes;
    }

    let results: PublishOutcome[];

    try {
      results = await this.publisher.publish(outbound);
    } catch (error) {
      const reason = describe(error);
      results = outbound.map((event) => ({ eventId: event.eventId, confirmed: false, reason }));
    }

    for (const outcome of results) {
      outcomes.set(outcome.eventId, outcome);
    }

    return outcomes;
  }

  private warnIfLate(message: OutboxMessage, reason: string): void {
    if (message.attempts > this.settings.alertAttempts) {
      this.logger.warn(
        `Evento ${message.id} (${message.eventType}) segue sem publicar após ${message.attempts} tentativas: ${reason}`,
      );
    }
  }
}

function walletIdOf(message: OutboxMessage): string | undefined {
  const data = message.payload.data;
  const walletId =
    typeof data === "object" && data !== null
      ? (data as { walletId?: unknown }).walletId
      : undefined;

  return typeof walletId === "string" && walletId !== "" ? walletId : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
