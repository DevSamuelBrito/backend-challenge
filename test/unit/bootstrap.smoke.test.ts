import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { loadConfig } from "../../src/config/env";

@Injectable()
class PingService {
  pong(): string {
    return "pong";
  }
}

@Controller("ping")
class PingController {
  constructor(private readonly service: PingService) {}

  @Get()
  ping(): { message: string } {
    return { message: this.service.pong() };
  }
}

@Module({ controllers: [PingController], providers: [PingService] })
class PingModule {}

describe("bootstrap: NestJS sobre Bun", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(PingModule, { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  test("resolve dependências por metadata de tipos e responde HTTP", async () => {
    const response = await fetch(`${baseUrl.replace("[::1]", "localhost")}/ping`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "pong" });
  });

  test("AppModule sobe e encerra sem erros", async () => {
    const root = await NestFactory.create(AppModule, { logger: false });
    await root.init();
    await root.close();
  });
});

describe("config: loadConfig", () => {
  test("usa porta 3000 e todos os papéis por padrão", () => {
    const config = loadConfig({});

    expect(config.port).toBe(3000);
    expect(config.roles).toEqual(["api", "consumer", "outbox", "pending-worker"]);
  });

  test("lê PORT e APP_ROLES do ambiente", () => {
    const config = loadConfig({ PORT: "4000", APP_ROLES: "api, outbox" });

    expect(config.port).toBe(4000);
    expect(config.roles).toEqual(["api", "outbox"]);
  });

  test("rejeita porta inválida", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow("PORT inválida");
    expect(() => loadConfig({ PORT: "70000" })).toThrow("PORT inválida");
  });

  test("rejeita papel desconhecido", () => {
    expect(() => loadConfig({ APP_ROLES: "api,foo" })).toThrow("papéis desconhecidos: foo");
  });
});
