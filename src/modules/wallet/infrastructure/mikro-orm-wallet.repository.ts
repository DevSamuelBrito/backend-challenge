import { type EntityManager, LockMode } from "@mikro-orm/core";
import { AggregateNotFoundError } from "../../../shared/application/persistence-errors";
import { isUniqueViolation } from "../../../shared/infrastructure/database/violations";
import type { WalletRepository } from "../application/wallet.repository";
import type { Wallet } from "../domain/wallet";
import { WalletAlreadyExistsError } from "../domain/wallet-errors";
import { walletMapper } from "./wallet.mapper";
import { type WalletRecord, WalletSchema } from "./wallet.schema";

const PLAYER_CURRENCY_CONSTRAINT = "wallets_player_currency_key";

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async add(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletSchema, walletMapper.toRecord(wallet));
    } catch (error) {
      if (isUniqueViolation(error, PLAYER_CURRENCY_CONSTRAINT)) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }

      throw error;
    }
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

  async findByIdForShare(id: string): Promise<Wallet | undefined> {
    return this.load({ id }, LockMode.PESSIMISTIC_READ);
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    return this.load({ id }, LockMode.PESSIMISTIC_WRITE);
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    return this.load({ playerId, currency });
  }

  private async load(
    where: Partial<WalletRecord>,
    lockMode?: LockMode.PESSIMISTIC_WRITE | LockMode.PESSIMISTIC_READ,
  ): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, where, {
      disableIdentityMap: true,
      refresh: true,
      lockMode,
    });

    return record ? walletMapper.toDomain(record) : undefined;
  }
}
