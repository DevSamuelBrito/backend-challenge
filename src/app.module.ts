import { type DynamicModule, Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module";
import type { AppConfig } from "./config/env";
import { HealthModule } from "./modules/health/health.module";
import { DatabaseModule } from "./shared/infrastructure/database/database.module";
import { SqsModule } from "./shared/infrastructure/sqs/sqs.module";

/**
 * Módulo raiz. Os módulos de domínio (wallet, wagering, messaging, auth)
 * são registrados aqui conforme as etapas do plan.md forem implementadas.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: padrão de módulo dinâmico do NestJS
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule, SqsModule, HealthModule],
    };
  }
}
