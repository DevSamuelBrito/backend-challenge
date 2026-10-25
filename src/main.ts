import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/env";
import { PinoLoggerService } from "./shared/infrastructure/observability/pino-logger";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.register(config), { bufferLogs: true });
  app.useLogger(app.get(PinoLoggerService));
  app.enableShutdownHooks(["SIGTERM", "SIGINT"], { useProcessExit: true });
  await app.listen(config.port);

  const address = app.getHttpServer().address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  new Logger("Bootstrap").log({ event: "app.listening", port, roles: config.roles });
}

bootstrap().catch((error: unknown) => {
  console.error("Falha ao iniciar a aplicaÃ§Ã£o", error);
  process.exit(1);
});
