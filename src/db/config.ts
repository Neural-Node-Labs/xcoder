import type { DatabaseType } from "./types.js";

/**
 * All configurable PostgreSQL connection parameters.
 *
 * Defaults: localhost:5432, devnull/devnull_pass, database=devnull
 */
export interface DatabaseConfig {
  /** Backend identifier. Always "postgres" — kept for forward compatibility. */
  type: DatabaseType;

  // ─── PostgreSQL connection ──────────────────────────────────────────────
  /** Full connection string (overrides individual params if set) */
  postgresUrl?: string;
  postgresHost: string;
  postgresPort: number;
  postgresDatabase: string;
  postgresUser: string;
  postgresPassword: string;
  postgresSsl: boolean;
  postgresMax: number;
  postgresIdleTimeoutMillis: number;
  postgresConnectionTimeoutMillis: number;
}

/**
 * Load database configuration from environment variables.
 *
 * Environment variables:
 *   DATABASE_URL           = PostgreSQL connection string (overrides individual params)
 *   DATABASE_HOST          = PostgreSQL host (default: localhost)
 *   DATABASE_PORT          = PostgreSQL port (default: 5432)
 *   DATABASE_NAME          = PostgreSQL database name (default: devnull)
 *   DATABASE_USER          = PostgreSQL user (default: devnull)
 *   DATABASE_PASSWORD      = PostgreSQL password (default: devnull_pass)
 *   DATABASE_SSL           = "true" to enable SSL (default: false)
 *   DATABASE_POOL_MAX      = max pool size (default: 5)
 *   DATABASE_POOL_IDLE     = idle timeout ms (default: 30000)
 *   DATABASE_POOL_TIMEOUT  = connection timeout ms (default: 5000)
 */
export function loadDatabaseConfig(): DatabaseConfig {
  return {
    type: "postgres",

    postgresUrl: process.env.DATABASE_URL,
    postgresHost: process.env.DATABASE_HOST || "localhost",
    postgresPort: parseInt(process.env.DATABASE_PORT || "5432", 10),
    postgresDatabase: process.env.DATABASE_NAME || "devnull",
    postgresUser: process.env.DATABASE_USER || "devnull",
    postgresPassword: process.env.DATABASE_PASSWORD || "devnull_pass",
    postgresSsl: process.env.DATABASE_SSL === "true",
    postgresMax: parseInt(process.env.DATABASE_POOL_MAX || "5", 10),
    postgresIdleTimeoutMillis: parseInt(process.env.DATABASE_POOL_IDLE || "30000", 10),
    postgresConnectionTimeoutMillis: parseInt(process.env.DATABASE_POOL_TIMEOUT || "5000", 10),
  };
}
