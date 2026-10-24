import { Inject, Injectable } from "@nestjs/common";
import { UNIT_OF_WORK, type UnitOfWork } from "../../../shared/application/unit-of-work.port";
import type { Wallet } from "../domain/wallet";
import { WalletNotFoundError } from "../domain/wallet-errors";

@Injectable()
export class GetWallet {
  constructor(@Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.unitOfWork.run(({ wallets }) => wallets.findById(walletId));

    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    return wallet;
  }
}
