import { type AppConfig, loadConfig } from "../../src/config/env";

const postgresHost = process.env.TEST_POSTGRES_HOST ?? "127.0.0.1";
const postgresPort = process.env.TEST_POSTGRES_PORT ?? "55432";
const localstackHost = process.env.TEST_LOCALSTACK_HOST ?? "127.0.0.1";
const localstackPort = process.env.TEST_LOCALSTACK_PORT ?? "45660";

/**
 * Configuração que aponta para a infra do docker-compose.test.yml (bun run infra:test:up).
 * 127.0.0.1 em vez de localhost evita cair em outro serviço que escute o IPv4/IPv6 da máquina.
 */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    PORT: "0",
    APP_ROLES: "api",
    METRICS_DEFAULT_METRICS: "false",
    DATABASE_URL: `postgres://wagering:wagering@${postgresHost}:${postgresPort}/wagering_test`,
    SQS_ENDPOINT: `http://${localstackHost}:${localstackPort}`,
    ...overrides,
  });
}
