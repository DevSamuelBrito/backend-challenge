import { Module } from "@nestjs/common";
import { PersistenceModule } from "../../shared/infrastructure/database/persistence.module";
import { SystemModule } from "../../shared/infrastructure/system/system.module";
import { AuthModule } from "../auth/auth.module";
import { GetWallet } from "./application/get-wallet";
import { GetWalletLedger } from "./application/get-wallet-ledger";
import { OpenWallet } from "./application/open-wallet";
import { ReconcileWallet } from "./application/reconcile-wallet";
import { WalletController } from "./http/wallet.controller";
import { WalletLedgerController } from "./http/wallet-ledger.controller";

@Module({
  imports: [PersistenceModule, SystemModule, AuthModule],
  controllers: [WalletController, WalletLedgerController],
  providers: [OpenWallet, GetWallet, GetWalletLedger, ReconcileWallet],
})
export class WalletModule {}
