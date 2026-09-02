/**
 * Database layer for devnull.
 *
 * PostgreSQL-only. Provides a connection factory and shared interfaces.
 *
 * Usage:
 *   import { createConnection, loadDatabaseConfig } from "../db/index.js";
 *   const db = createConnection();
 *   await db.init();
 *   await db.query("SELECT 1");
 *   await db.close();
 */

export type { DatabaseType, DatabaseClient, QueryResult } from "./types.js";
export type { DatabaseConfig } from "./config.js";
export { loadDatabaseConfig } from "./config.js";
export { createConnection, createConnectionAsync } from "./connection.js";
export { PostgresClient } from "./postgresClient.js";
