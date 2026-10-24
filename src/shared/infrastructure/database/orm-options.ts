import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { ENTITY_SCHEMAS } from "./entity-schemas";

export function buildOrmOptions(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: ENTITY_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      path: "migrations",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
