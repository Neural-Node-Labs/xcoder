import type { DatabaseClient } from "../db/types.js";
import { createConnection } from "../db/connection.js";

/**
 * A task history entry stored in the database.
 */
export interface TaskHistoryRecord {
  id: string;
  task: string;
  summary: string;
  timestamp: string;
  iterations: number;
  totalTokens: number | null;
}

/**
 * Database-backed store for task history.
 * Stores task history entries with summary, token, and iteration tracking.
 * Falls back gracefully if the database is unreachable.
 *
 * Accepts a PostgreSQL DatabaseClient instead of creating its own connection.
 */
export class TaskHistoryStore {
  private db: DatabaseClient;

  constructor(db?: DatabaseClient) {
    this.db = db ?? createConnection();
  }

  async init(): Promise<void> {
    if (this.db.initialized) return;
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
    } catch (err) {
      console.warn("[TaskHistoryStore] Failed to initialize:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Save a task history entry.
   */
  async save(entry: Omit<TaskHistoryRecord, "id" | "timestamp">): Promise<TaskHistoryRecord | null> {
    try {
      if (!this.db.initialized) await this.init();
      const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const timestamp = new Date().toISOString();

      await this.db.query(
        `INSERT INTO task_history (id, task, summary, timestamp, iterations, total_tokens)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           task = EXCLUDED.task,
           summary = EXCLUDED.summary,
           timestamp = EXCLUDED.timestamp,
           iterations = EXCLUDED.iterations,
           total_tokens = EXCLUDED.total_tokens`,
        [id, entry.task, entry.summary, timestamp, entry.iterations, entry.totalTokens ?? null]
      );

      return { id, ...entry, timestamp, totalTokens: entry.totalTokens ?? null };
    } catch (err) {
      console.warn("[TaskHistoryStore] Failed to save:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Get a task history entry by ID.
   */
  async getById(id: string): Promise<TaskHistoryRecord | null> {
    try {
      if (!this.db.initialized) await this.init();
      const result = await this.db.query<TaskHistoryRecord>(
        `SELECT id, task, summary, timestamp, iterations, total_tokens as "totalTokens"
         FROM task_history WHERE id = $1`,
        [id]
      );
      if (!result.rows[0]) return null;
      const row = result.rows[0];
      return {
        id: row.id,
        task: row.task,
        summary: row.summary,
        timestamp: row.timestamp,
        iterations: row.iterations,
        totalTokens: row.totalTokens,
      };
    } catch (err) {
      console.warn("[TaskHistoryStore] Failed to getById:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * List task history entries, newest first.
   */
  async list(limit = 10): Promise<TaskHistoryRecord[]> {
    try {
      if (!this.db.initialized) await this.init();
      const result = await this.db.query<TaskHistoryRecord>(
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
        totalTokens: row.totalTokens,
      }));
    } catch (err) {
      console.warn("[TaskHistoryStore] Failed to list:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async close(): Promise<void> {
    try {
      await this.db.close();
    } catch {
      // ignore close errors
    }
  }
}
