import type { DatabaseClient } from "../db/types.js";
import { createConnection } from "../db/connection.js";
import { TaskHistoryEntry } from "./taskHistory.js";

/**
 * Database-backed na imbakan ng task history.
 * Iniimbak ang mga entry ng task history sa isang talahanayan ng database.
 * Maayos na bumabalik sa fallback kung hindi maabot ang database.
 *
 * Tumatanggap ng PostgreSQL DatabaseClient sa halip na gumawa ng sarili nitong koneksyon.
 */
export class PostgresTaskHistory {
  private db: DatabaseClient;
  private initialized = false;

  constructor(db?: DatabaseClient) {
    this.db = db ?? createConnection();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS task_history (
          id TEXT PRIMARY KEY,
          task TEXT NOT NULL,
          summary TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          iterations INTEGER DEFAULT 0,
          total_tokens INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_task_history_timestamp ON task_history(timestamp DESC);
      `);
      this.initialized = true;
    } catch (err) {
      console.warn("[PostgresTaskHistory] Failed to initialize:", err instanceof Error ? err.message : String(err));
    }
  }

  async append(entry: TaskHistoryEntry): Promise<void> {
    try {
      if (!this.initialized) await this.init();
      await this.db.query(
        `INSERT INTO task_history (id, task, summary, timestamp, iterations, total_tokens)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           task = EXCLUDED.task,
           summary = EXCLUDED.summary,
           timestamp = EXCLUDED.timestamp,
           iterations = EXCLUDED.iterations,
           total_tokens = EXCLUDED.total_tokens`,
        [entry.id, entry.task, entry.summary, entry.timestamp, entry.iterations, entry.totalTokens ?? null]
      );
    } catch (err) {
      console.warn("[PostgresTaskHistory] Failed to append:", err instanceof Error ? err.message : String(err));
    }
  }

  async read(limit = 10): Promise<TaskHistoryEntry[]> {
    try {
      if (!this.initialized) await this.init();
      const result = await this.db.query<any>(
        `SELECT id, task, summary, timestamp, iterations, total_tokens as "totalTokens"
         FROM task_history ORDER BY timestamp DESC LIMIT $1`,
        [limit]
      );
      return result.rows.map((row: any) => ({
        id: row.id,
        task: row.task,
        summary: row.summary,
        timestamp: row.timestamp,
        iterations: row.iterations,
        totalTokens: row.total_tokens,
      }));
    } catch (err) {
      console.warn("[PostgresTaskHistory] Failed to read:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async search(query: string, limit = 10): Promise<TaskHistoryEntry[]> {
    try {
      if (!this.initialized) await this.init();
      const result = await this.db.query<any>(
        `SELECT id, task, summary, timestamp, iterations, total_tokens as "totalTokens"
         FROM task_history
         WHERE task ILIKE $1 OR summary ILIKE $2
         ORDER BY timestamp DESC LIMIT $3`,
        [`%${query}%`, `%${query}%`, limit]
      );
      return result.rows.map((row: any) => ({
        id: row.id,
        task: row.task,
        summary: row.summary,
        timestamp: row.timestamp,
        iterations: row.iterations,
        totalTokens: row.total_tokens,
      }));
    } catch (err) {
      console.warn("[PostgresTaskHistory] Failed to search:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async close(): Promise<void> {
    try {
      await this.db.close();
    } catch {
      // huwag pansinin ang mga error sa pagsara
    }
  }
}
