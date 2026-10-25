import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { parseUuid } from "../../../shared/application/parse-uuid";
import { AuthGuard } from "../../auth/auth.guard";
import { GetWalletLedger } from "../application/get-wallet-ledger";
import { parseLedgerPageQuery } from "../application/ledger-page-query";
import { ReconcileWallet } from "../application/reconcile-wallet";
import {
  type LedgerPageResponse,
  type ReconciliationResponse,
  toLedgerPageResponse,
  toReconciliationResponse,
} from "./ledger.response";

@Controller("wallets/:walletId")
@UseGuards(AuthGuard)
export class WalletLedgerController {
  constructor(
    private readonly getWalletLedger: GetWalletLedger,
    private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Get("ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: unknown,
    @Query("limit") limit: unknown,
  ): Promise<LedgerPageResponse> {
    const id = parseUuid(walletId, "walletId");
    const query = parseLedgerPageQuery({ cursor, limit });

    return toLedgerPageResponse(await this.getWalletLedger.execute(id, query));
  }

  @Post("reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string): Promise<ReconciliationResponse> {
    return toReconciliationResponse(
      await this.reconcileWallet.execute(parseUuid(walletId, "walletId")),
    );
  }
}
