import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";


export function buildOrmOptions(databaseUrl: string) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      path: "migrations",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
