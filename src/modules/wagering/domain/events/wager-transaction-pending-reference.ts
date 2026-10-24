import {
  type EventContext,
  eventPropsFrom,
  IntegrationEvent,
  type IntegrationEventProps,
  InvalidIntegrationEventError,
} from "../../../../shared/events/integration-event";
import { type WagerTransaction, WagerTransactionStatus } from "../wager-transaction";
import { baseDataOf, type WagerEventBaseData } from "./wager-event-data";

export interface WagerTransactionPendingReferenceData extends WagerEventBaseData {
  status: WagerTransactionStatus.PendingReference;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    const { referenceExternalTransactionId } = transaction;

    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      !referenceExternalTransactionId
    ) {
      throw new InvalidIntegrationEventError(
        `WagerTransactionPendingReference exige transação PENDING_REFERENCE com referência, recebeu ${transaction.status}`,
      );
    }

    return new WagerTransactionPendingReference(
      eventPropsFrom(transaction.id, context, {
        ...baseDataOf(transaction),
        status: WagerTransactionStatus.PendingReference,
        referenceExternalTransactionId,
      }),
    );
  }
}
