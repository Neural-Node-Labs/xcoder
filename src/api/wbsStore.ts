import type { DatabaseClient } from "../db/types.js";
import { createConnection } from "../db/connection.js";

/**
 * A WBS entry stored in the database.
 */
export interface WbsEntry {
  id: string;
  taskId: string;
  taskDescription: string;
  phaseNumber: number;
  phaseTitle: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  createdAt: string;
  updatedAt: string;
}

/**
 * Database-backed store for WBS entries.
 * Stores WBS entries with status tracking per phase.
 * Falls back gracefully if the database is unreachable.
 *
 * Accepts a PostgreSQL DatabaseClient instead of creating its own connection.
 */
export class WbsStore {
  private db: DatabaseClient;

  constructor(db?: DatabaseClient) {
    this.db = db ?? createConnection();
  }

  async init(): Promise<void> {
    if (this.db.initialized) return;
    try {
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS wbs_entries (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          task_description TEXT NOT NULL,
          phase_number INTEGER NOT NULL,
          phase_title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_wbs_entries_task_id ON wbs_entries(task_id);
      `);
    } catch (err) {
      console.warn("[WbsStore] Failed to initialize:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Save a batch of WBS entries for a task (one per phase).
   */
  async saveBatch(entries: Omit<WbsEntry, "id" | "createdAt" | "updatedAt">[]): Promise<boolean> {
    try {
      if (!this.db.initialized) await this.init();
      const now = new Date().toISOString();

      for (const entry of entries) {
        const id = `wbs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${entry.phaseNumber}`;
        await this.db.query(
          `INSERT INTO wbs_entries (id, task_id, task_description, phase_number, phase_title, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at`,
          [id, entry.taskId, entry.taskDescription, entry.phaseNumber, entry.phaseTitle, entry.status, now, now]
        );
      }

      return true;
    } catch (err) {
      console.warn("[WbsStore] Failed to saveBatch:", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /**
   * Get a WBS entry by ID.
   */
  async get(id: string): Promise<WbsEntry | null> {
    try {
      if (!this.db.initialized) await this.init();
      const result = await this.db.query<WbsEntry>(
        `SELECT id, task_id as "taskId", task_description as "taskDescription",
                phase_number as "phaseNumber", phase_title as "phaseTitle",
                status, created_at as "createdAt", updated_at as "updatedAt"
         FROM wbs_entries WHERE id = $1`,
        [id]
      );
      return result.rows[0] ?? null;
    } catch (err) {
      console.warn("[WbsStore] Failed to get:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Update the status of a WBS entry.
   */
  async updateStatus(taskId: string, phaseNumber: number, status: WbsEntry["status"]): Promise<boolean> {
    try {
      if (!this.db.initialized) await this.init();
      const now = new Date().toISOString();
      const result = await this.db.query(
        `UPDATE wbs_entries SET status = $1, updated_at = $2
         WHERE task_id = $3 AND phase_number = $4`,
        [status, now, taskId, phaseNumber]
      );
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      console.warn("[WbsStore] Failed to updateStatus:", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /**
   * List WBS entries for a task, ordered by phase number.
   */
  async listByTask(taskId: string): Promise<WbsEntry[]> {
    try {
      if (!this.db.initialized) await this.init();
      const result = await this.db.query<WbsEntry>(
        `SELECT id, task_id as "taskId", task_description as "taskDescription",
                phase_number as "phaseNumber", phase_title as "phaseTitle",
                status, created_at as "createdAt", updated_at as "updatedAt"
         FROM wbs_entries WHERE task_id = $1 ORDER BY phase_number ASC`,
        [taskId]
      );
      return result.rows;
    } catch (err) {
      console.warn("[WbsStore] Failed to listByTask:", err instanceof Error ? err.message : String(err));
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
