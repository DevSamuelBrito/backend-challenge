import { Module } from "@nestjs/common";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env";
import { PersistenceModule } from "../../shared/infrastructure/database/persistence.module";
import { SystemModule } from "../../shared/infrastructure/system/system.module";
import { EVENT_PUBLISHER } from "./application/event-publisher.port";
import { OUTBOX_SETTINGS, OutboxPublisher } from "./application/outbox-publisher";
import { OutboxScheduler } from "./infrastructure/outbox.scheduler";
import { SqsEventPublisher } from "./infrastructure/sqs-event-publisher";

@Module({
  imports: [PersistenceModule, SystemModule],
  providers: [
    OutboxPublisher,
    OutboxScheduler,
    { provide: EVENT_PUBLISHER, useClass: SqsEventPublisher },
    {
      provide: OUTBOX_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        batchSize: config.outbox.batchSize,
        alertAttempts: config.outbox.alertAttempts,
      }),
    },
  ],
})
export class MessagingModule {}
