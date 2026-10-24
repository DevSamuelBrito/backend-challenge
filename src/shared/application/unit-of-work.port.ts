import type { InboxRepository } from "../../modules/messaging/application/inbox.repository";
import type { OutboxRepository } from "../../modules/messaging/application/outbox.repository";
import type { WagerTransactionRepository } from "../../modules/wagering/application/wager-transaction.repository";
import type { LedgerRepository } from "../../modules/wallet/application/ledger.repository";
import type { WalletRepository } from "../../modules/wallet/application/wallet.repository";

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
