import { Module } from "@nestjs/common";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env";
import { PersistenceModule } from "../../shared/infrastructure/database/persistence.module";
import { SystemModule } from "../../shared/infrastructure/system/system.module";
import { AuthModule } from "../auth/auth.module";
import { MessagingModule } from "../messaging/messaging.module";
import {
  PENDING_REFERENCE_SETTINGS,
  PendingReferenceWorker,
} from "./application/pending-reference-worker";
import { ProcessWagerTransaction } from "./application/process-wager-transaction";
import { WagerSettlement } from "./application/wager-settlement";
import { WagerTransactionController } from "./http/wager-transaction.controller";
import { PendingReferenceScheduler } from "./infrastructure/pending-reference.scheduler";
import { WagerTransactionConsumer } from "./messaging/wager-transaction.consumer";
import { WagerTransactionMessageHandler } from "./messaging/wager-transaction-message.handler";

@Module({
  imports: [PersistenceModule, SystemModule, AuthModule, MessagingModule],
  controllers: [WagerTransactionController],
  providers: [
    ProcessWagerTransaction,
    WagerTransactionMessageHandler,
    WagerTransactionConsumer,
    WagerSettlement,
    PendingReferenceWorker,
    PendingReferenceScheduler,
    {
      provide: PENDING_REFERENCE_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        maxAttempts: config.pendingReference.maxAttempts,
        ttlMs: config.pendingReference.ttlMs,
        batchSize: config.pendingReference.batchSize,
      }),
    },
  ],
})
export class WageringModule {}
