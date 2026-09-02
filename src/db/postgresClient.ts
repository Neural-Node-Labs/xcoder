import pg from "pg";
import type { DatabaseClient, QueryResult } from "./types.js";
import type { DatabaseConfig } from "./config.js";

const { Pool } = pg;

/**
 * PostgreSQL-backed database client.
 * Wraps pg.Pool with the DatabaseClient interface.
 *
 * Follows the same graceful fallback pattern as the existing Postgres stores:
 * - init() is a no-op (schema creation is per-store responsibility)
 * - All public methods catch errors, log warnings, and return safe fallbacks
 * - close() ends the pool
 *
 * Accepts either a DatabaseConfig object or a connection string.
 * When a string is passed, it's treated as a PostgreSQL connection URL
 * and converted to a DatabaseConfig internally. This maintains backward
 * compatibility with code that passes raw connection strings.
 */
export class PostgresClient implements DatabaseClient {
  private pool: pg.Pool;
  private _initialized = false;

  constructor(config: DatabaseConfig | string) {
    // If a string is passed, treat it as a connection URL
    if (typeof config === "string") {
      this.pool = new Pool({
        connectionString: config,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });
      return;
    }

    if (config.postgresUrl) {
      this.pool = new Pool({
        connectionString: config.postgresUrl,
        max: config.postgresMax,
        idleTimeoutMillis: config.postgresIdleTimeoutMillis,
        connectionTimeoutMillis: config.postgresConnectionTimeoutMillis,
      });
    } else {
      this.pool = new Pool({
        host: config.postgresHost,
        port: config.postgresPort,
        database: config.postgresDatabase,
        user: config.postgresUser,
        password: config.postgresPassword,
        ssl: config.postgresSsl ? { rejectUnauthorized: false } : false,
        max: config.postgresMax,
        idleTimeoutMillis: config.postgresIdleTimeoutMillis,
        connectionTimeoutMillis: config.postgresConnectionTimeoutMillis,
      });
    }
  }

  get initialized(): boolean {
    return this._initialized;
  }

  async init(): Promise<void> {
    // PostgresClient doesn't manage schema — that's per-store responsibility.
    // init() verifies connectivity by running a simple query.
    if (this._initialized) return;
    try {
      const client = await this.pool.connect();
      try {
        await client.query("SELECT 1");
        this._initialized = true;
      } finally {
        client.release();
      }
    } catch (err) {
      console.warn("[PostgresClient] Failed to initialize:", err instanceof Error ? err.message : String(err));
    }
  }

  async query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    try {
      if (!this._initialized) await this.init();
      const result = await this.pool.query(text, params);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount ?? 0,
      };
    } catch (err) {
      console.warn("[PostgresClient] Query failed:", err instanceof Error ? err.message : String(err));
      return { rows: [], rowCount: 0 };
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.end();
      this._initialized = false;
    } catch {
      // ignore close errors
    }
  }
}

