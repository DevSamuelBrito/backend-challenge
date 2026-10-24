import type { MoneyProps } from "../../../../shared/domain/money";
import {
  type EventContext,
  eventPropsFrom,
  IntegrationEvent,
  type IntegrationEventProps,
} from "../../../../shared/events/integration-event";
import type { LedgerDirection } from "../ledger-direction";
import type { WalletLedgerEntry } from "../wallet-ledger-entry";

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      eventPropsFrom(entry.walletId, context, {
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}
