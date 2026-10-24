import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import type { AppConfig } from "../../src/config/env";

export interface RunningApp {
  app: INestApplication;
  url: string;
}

/** Sobe a aplicação inteira em uma porta livre, com a configuração recebida. */
export async function startApp(config: AppConfig): Promise<RunningApp> {
  const app = await NestFactory.create(AppModule.register(config), { logger: ["error"] });
  await app.listen(0, "127.0.0.1");

  return { app, url: await app.getUrl() };
}
