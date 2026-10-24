import type { MoneyProps } from "../../../../shared/domain/money";
import {
  type EventContext,
  eventPropsFrom,
  IntegrationEvent,
  type IntegrationEventProps,
  InvalidIntegrationEventError,
} from "../../../../shared/events/integration-event";
import { type WagerTransaction, WagerTransactionStatus } from "../wager-transaction";
import { baseDataOf, type WagerEventBaseData } from "./wager-event-data";

export interface WagerTransactionProcessedData extends WagerEventBaseData {
  status: WagerTransactionStatus.Processed;
  balanceAfter: MoneyProps;
  referenceTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    const { balanceAfter, referenceTransactionId } = transaction;

    if (transaction.status !== WagerTransactionStatus.Processed || !balanceAfter) {
      throw new InvalidIntegrationEventError(
        `WagerTransactionProcessed exige transação PROCESSED com saldo, recebeu ${transaction.status}`,
      );
    }

    return new WagerTransactionProcessed(
      eventPropsFrom(transaction.id, context, {
        ...baseDataOf(transaction),
        status: WagerTransactionStatus.Processed,
        balanceAfter: balanceAfter.toJSON(),
        ...(referenceTransactionId && { referenceTransactionId }),
      }),
    );
  }
}
