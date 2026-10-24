import { Module } from "@nestjs/common";
import { PersistenceModule } from "../../shared/infrastructure/database/persistence.module";
import { SystemModule } from "../../shared/infrastructure/system/system.module";
import { AuthModule } from "../auth/auth.module";
import { GetWallet } from "./application/get-wallet";
import { OpenWallet } from "./application/open-wallet";
import { WalletController } from "./http/wallet.controller";

@Module({
  imports: [PersistenceModule, SystemModule, AuthModule],
  controllers: [WalletController],
  providers: [OpenWallet, GetWallet],
})
export class WalletModule {}
