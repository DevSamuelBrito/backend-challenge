import type { EntityManager } from "@mikro-orm/postgresql";
import { MikroOrmInboxRepository } from "../../../modules/messaging/infrastructure/mikro-orm-inbox.repository";
import { MikroOrmOutboxRepository } from "../../../modules/messaging/infrastructure/mikro-orm-outbox.repository";
import { MikroOrmWagerTransactionRepository } from "../../../modules/wagering/infrastructure/mikro-orm-wager-transaction.repository";
import { MikroOrmLedgerRepository } from "../../../modules/wallet/infrastructure/mikro-orm-ledger.repository";
import { MikroOrmWalletRepository } from "../../../modules/wallet/infrastructure/mikro-orm-wallet.repository";
import type { Repositories } from "../../application/unit-of-work.port";

export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
