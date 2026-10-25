import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ConfigModule } from "./config/config.module";
import type { AppConfig } from "./config/env";
import { HealthModule } from "./modules/health/health.module";
import { MessagingModule } from "./modules/messaging/messaging.module";
import { WageringModule } from "./modules/wagering/wagering.module";
import { WalletModule } from "./modules/wallet/wallet.module";
import { DatabaseModule } from "./shared/infrastructure/database/database.module";
import { PersistenceModule } from "./shared/infrastructure/database/persistence.module";
import { AllExceptionsFilter } from "./shared/infrastructure/http/all-exceptions.filter";
import { ObservabilityModule } from "./shared/infrastructure/observability/observability.module";
import { SqsModule } from "./shared/infrastructure/sqs/sqs.module";

/**
 * Módulo raiz. Os módulos de domínio (wagering, messaging)
 * são registrados aqui conforme as etapas do plan.md forem implementadas.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: padrão de módulo dinâmico do NestJS
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule,
        PersistenceModule,
        SqsModule,
        ObservabilityModule,
        HealthModule,
        WalletModule,
        WageringModule,
        MessagingModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    };
  }
}
