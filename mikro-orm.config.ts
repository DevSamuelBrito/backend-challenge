import { loadConfig } from "./src/config/env";
import { buildOrmOptions } from "./src/shared/infrastructure/database/orm-options";

export default buildOrmOptions(loadConfig().databaseUrl);
