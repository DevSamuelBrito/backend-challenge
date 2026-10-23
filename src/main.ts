import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/env";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(config.port);
}

bootstrap().catch((error: unknown) => {
  console.error("Falha ao iniciar a aplicação", error);
  process.exit(1);
});
