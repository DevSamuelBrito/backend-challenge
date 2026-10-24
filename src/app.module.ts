import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ConfigModule } from "./config/config.module";
import type { AppConfig } from "./config/env";
import { HealthModule } from "./modules/health/health.module";
import { WalletModule } from "./modules/wallet/wallet.module";
import { DatabaseModule } from "./shared/infrastructure/database/database.module";
import { PersistenceModule } from "./shared/infrastructure/database/persistence.module";
import { AllExceptionsFilter } from "./shared/infrastructure/http/all-exceptions.filter";
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
        HealthModule,
        WalletModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    };
  }
}
