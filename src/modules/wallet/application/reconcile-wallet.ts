import { Inject, Injectable, Logger } from "@nestjs/common";
import { UNIT_OF_WORK, type UnitOfWork } from "../../../shared/application/unit-of-work.port";
import type { Money } from "../../../shared/domain/money";
import { WalletNotFoundError } from "../domain/wallet-errors";

export interface WalletReconciliation {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWallet {
  private readonly logger = new Logger(ReconcileWallet.name);

  constructor(@Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletReconciliation> {
    const result = await this.unitOfWork.run(async ({ wallets, ledger }) => {
      const wallet = await wallets.findByIdForShare(walletId);

      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }

      const { calculatedBalance, entries } = await ledger.summarize(walletId, wallet.currency);
      const difference = wallet.balance.subtract(calculatedBalance);

      return {
        walletId,
        storedBalance: wallet.balance,
        calculatedBalance,
        difference,
        consistent: difference.isZero(),
        checkedEntries: entries,
      };
    });

    if (!result.consistent) {
      this.reportMismatch(result);
    }

    return result;
  }

  private reportMismatch(result: WalletReconciliation): void {
    // Ponto da métrica de divergências de reconciliação (etapa 15).
    this.logger.error({
      event: "wallet.reconciliation_mismatch",
      walletId: result.walletId,
      storedBalance: result.storedBalance.toJSON(),
      calculatedBalance: result.calculatedBalance.toJSON(),
      difference: result.difference.toJSON(),
      checkedEntries: result.checkedEntries,
    });
  }
}
