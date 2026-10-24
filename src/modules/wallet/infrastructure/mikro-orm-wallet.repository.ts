import { type EntityManager, LockMode } from "@mikro-orm/core";
import { AggregateNotFoundError } from "../../../shared/application/persistence-errors";
import type { WalletRepository } from "../application/wallet.repository";
import type { Wallet } from "../domain/wallet";
import { walletMapper } from "./wallet.mapper";
import { type WalletRecord, WalletSchema } from "./wallet.schema";

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async add(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, walletMapper.toRecord(wallet));
  }

  async save(wallet: Wallet): Promise<void> {
    const { balance, version, updatedAt } = walletMapper.toRecord(wallet);

    const updated = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id },
      { balance, version, updatedAt },
    );

    if (updated === 0) {
      throw new AggregateNotFoundError("Wallet", wallet.id);
    }
  }

  async findById(id: string): Promise<Wallet | undefined> {
    return this.load({ id });
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    return this.load({ id }, LockMode.PESSIMISTIC_WRITE);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    return this.load({ playerId, currency });
  }

  private async load(
    where: Partial<WalletRecord>,
    lockMode?: LockMode.PESSIMISTIC_WRITE,
  ): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, where, {
      disableIdentityMap: true,
      refresh: true,
      lockMode,
    });

    return record ? walletMapper.toDomain(record) : undefined;
  }
}
