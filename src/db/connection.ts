import type { DatabaseClient } from "./types.js";
import type { DatabaseConfig } from "./config.js";
import { loadDatabaseConfig } from "./config.js";
import { PostgresClient } from "./postgresClient.js";

/**
 * Create a PostgreSQL database client based on the provided configuration.
 *
 * Usage:
 *   const db = createConnection();           // Postgres with env-loaded config
 *   const db = createConnection(myConfig);   // explicit config
 *   const db = await createConnectionAsync(); // convenience: loads config + creates + inits
 */
export function createConnection(config?: DatabaseConfig): DatabaseClient {
  const resolved = config ?? loadDatabaseConfig();
  return new PostgresClient(resolved);
}

/**
 * Convenience function: loads config from env vars, creates the connection, and initializes it.
 * Equivalent to `createConnection(loadDatabaseConfig())` followed by `.init()`.
 */
export async function createConnectionAsync(): Promise<DatabaseClient> {
  const config = loadDatabaseConfig();
  const client = createConnection(config);
  await client.init();
  return client;
}
