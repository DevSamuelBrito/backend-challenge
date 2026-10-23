export type AppRole = "api" | "consumer" | "outbox" | "pending-worker";

const ALL_ROLES: readonly AppRole[] = ["api", "consumer", "outbox", "pending-worker"];

export interface AppConfig {
  port: number;
  roles: readonly AppRole[];
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const port = Number(env.PORT ?? 3000);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT inválida: ${env.PORT}`);
  }

  const rawRoles = (env.APP_ROLES ?? ALL_ROLES.join(","))
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role.length > 0);

  const unknown = rawRoles.filter((role) => !ALL_ROLES.includes(role as AppRole));

  if (unknown.length > 0) {
    throw new Error(`APP_ROLES contém papéis desconhecidos: ${unknown.join(", ")}`);
  }

  return { port, roles: rawRoles as AppRole[] };
}
