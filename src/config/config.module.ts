import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { AppConfig } from "./env";

export const APP_CONFIG = Symbol("APP_CONFIG");

@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: padrão de módulo dinâmico do NestJS
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
