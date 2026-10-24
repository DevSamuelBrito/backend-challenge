import { Module } from "@nestjs/common";
import { PersistenceModule } from "../../shared/infrastructure/database/persistence.module";
import { SystemModule } from "../../shared/infrastructure/system/system.module";
import { AuthModule } from "../auth/auth.module";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { WagerTransactionController } from "./http/wager-transaction.controller";

@Module({
  imports: [PersistenceModule, SystemModule, AuthModule],
  controllers: [WagerTransactionController],
  providers: [ProcessWagerTransaction],
})
export class WageringModule {}
