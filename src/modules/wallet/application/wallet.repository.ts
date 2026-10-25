import type { Wallet } from "../domain/wallet";

export interface WalletRepository {
  add(wallet: Wallet): Promise<void>;
  save(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  findByIdForShare(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
}
