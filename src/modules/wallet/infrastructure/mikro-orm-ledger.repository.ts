import type { EntityManager } from "@mikro-orm/core";
import type { LedgerRepository } from "../application/ledger.repository";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { ledgerEntryMapper } from "./ledger-entry.mapper";
import { LedgerEntrySchema } from "./ledger-entry.schema";

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerEntryMapper.toRecord(entry));
  }
}
