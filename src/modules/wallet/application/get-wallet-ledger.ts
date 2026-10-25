import { Inject, Injectable } from "@nestjs/common";
import { UNIT_OF_WORK, type UnitOfWork } from "../../../shared/application/unit-of-work.port";
import { WalletNotFoundError } from "../domain/wallet-errors";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { encodeLedgerCursor } from "./ledger-cursor";
import type { LedgerPageQuery } from "./ledger-page-query";

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

@Injectable()
export class GetWalletLedger {
  constructor(@Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string, query: LedgerPageQuery): Promise<LedgerPage> {
    const rows = await this.unitOfWork.run(async ({ wallets, ledger }) => {
      if (!(await wallets.findById(walletId))) {
        throw new WalletNotFoundError(walletId);
      }

      return ledger.findPage(walletId, query.afterSeq, query.limit + 1);
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      entries: page.map((row) => row.entry),
      nextCursor: rows.length > query.limit && last ? encodeLedgerCursor(last.seq) : null,
    };
  }
}
