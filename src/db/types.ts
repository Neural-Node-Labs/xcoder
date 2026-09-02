/**
 * Supported database backend.
 * PostgreSQL is the only backend devnull supports.
 */
export type DatabaseType = "postgres";

/**
 * Result of a database query.
 */
export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

/**
 * Common interface for the database client.
 */
export interface DatabaseClient {
  /** Initialize the database (verify connectivity, create tables, etc.). Safe to call multiple times. */
  init(): Promise<void>;

  /** Execute a query with optional parameters ($1, $2, ... placeholders). Returns rows and count. */
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;

  /** Close the database connection / pool. */
  close(): Promise<void>;

  /** Whether the database has been initialized. */
  readonly initialized: boolean;
}
