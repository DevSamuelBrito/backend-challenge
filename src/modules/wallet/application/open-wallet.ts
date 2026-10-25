import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../../shared/application/clock.port";
import { ID_GENERATOR, type IdGenerator } from "../../../shared/application/id-generator.port";
import { currentContext, enrichContext } from "../../../shared/application/request-context";
import { UNIT_OF_WORK, type UnitOfWork } from "../../../shared/application/unit-of-work.port";
import type { Money } from "../../../shared/domain/money";
import type { EventContext } from "../../../shared/events/integration-event";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { WagerTransactionProcessed } from "../../wagering/domain/events/wager-transaction-processed";
import { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import { Wallet } from "../domain/wallet";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
}

@Injectable()
export class OpenWallet {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const at = this.clock.now();

    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openingTransactionId: this.ids.next(),
      openingEntryId: this.ids.next(),
      at,
    });

    await this.unitOfWork.run(async ({ wallets, transactions, ledger, outbox }) => {
      await wallets.add(wallet);

      if (!openingEntry) {
        return;
      }

      const opening = WagerTransaction.createOpening({
        id: openingEntry.transactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: command.initialBalance,
        createdAt: at,
      });

      const correlationId = currentContext().correlationId ?? this.ids.next();
      const contextFor = (): EventContext => ({
        eventId: this.ids.next(),
        correlationId,
        causationId: opening.idempotencyKey,
        occurredAt: at,
      });

      await transactions.add(opening);
      await ledger.append(openingEntry);
      await outbox.add(
        OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, contextFor())),
      );
      await outbox.add(
        OutboxMessage.enqueue(WalletBalanceChanged.from(openingEntry, contextFor())),
      );
    });

    enrichContext({ walletId: wallet.id });

    return wallet;
  }
}
