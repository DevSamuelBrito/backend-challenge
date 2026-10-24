import {
  type EventContext,
  eventPropsFrom,
  IntegrationEvent,
  type IntegrationEventProps,
  InvalidIntegrationEventError,
} from "../../../../shared/events/integration-event";
import type { FailureCode } from "../failure-code";
import { type WagerTransaction, WagerTransactionStatus } from "../wager-transaction";
import { baseDataOf, type WagerEventBaseData } from "./wager-event-data";

export interface WagerTransactionRejectedData extends WagerEventBaseData {
  status: WagerTransactionStatus.Rejected;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    const { failureCode } = transaction;

    if (transaction.status !== WagerTransactionStatus.Rejected || !failureCode) {
      throw new InvalidIntegrationEventError(
        `WagerTransactionRejected exige transação REJECTED com failureCode, recebeu ${transaction.status}`,
      );
    }

    return new WagerTransactionRejected(
      eventPropsFrom(transaction.id, context, {
        ...baseDataOf(transaction),
        status: WagerTransactionStatus.Rejected,
        failureCode,
      }),
    );
  }
}
