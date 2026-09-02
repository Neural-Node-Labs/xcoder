import type { DatabaseClient } from "../db/types.js";
import { createConnection } from "../db/connection.js";

/**
 * A phase report stored in the database.
 */
export interface PhaseReport {
  id: string;
  taskId: string;
  phaseNumber: number;
  phaseTitle: string;
  content: string;
  tokens: number;
  iterations: number;
  createdAt: string;
}

/**
 * Database-backed store for phase reports.
 * Stores phase report content, tokens, and iterations per phase.
 * Falls back gracefully if the database is unreachable.
 *
 * Accepts a PostgreSQL DatabaseClient instead of creating its own connection.
 */
export class PhaseReportStore {
  private db: DatabaseClient;

  constructor(db?: DatabaseClient) {
    this.db = db ?? createConnection();
  }

  async init(): Promise<void> {
    try {
      if (this.db.initialized) return;
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS phase_reports (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          phase_number INTEGER NOT NULL,
          phase_title TEXT NOT NULL,
          content TEXT NOT NULL,
          tokens INTEGER DEFAULT 0,
          iterations INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_phase_reports_task_id ON phase_reports(task_id);
      `);
    } catch (err) {
      console.warn("[PhaseReportStore] Failed to initialize:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Save a phase report.
   */
  async save(report: Omit<PhaseReport, "id" | "createdAt">): Promise<PhaseReport | null> {
    try {
      if (!this.db.initialized) await this.init();
      const id = `phase_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      await this.db.query(
        `INSERT INTO phase_reports (id, task_id, phase_number, phase_title, content, tokens, iterations, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           content = EXCLUDED.content,
           tokens = EXCLUDED.tokens,
           iterations = EXCLUDED.iterations`,
        [id, report.taskId, report.phaseNumber, report.phaseTitle, report.content, report.tokens, report.iterations, now]
      );

      return { id, ...report, createdAt: now };
    } catch (err) {
      console.warn("[PhaseReportStore] Failed to save:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Get a phase report by ID.
   */
  async get(id: string): Promise<PhaseReport | null> {
    try {
      if (!this.db.initialized) await this.init();
      const result = await this.db.query<PhaseReport>(
        `SELECT id, task_id as "taskId", phase_number as "phaseNumber", phase_title as "phaseTitle",
                content, tokens, iterations, created_at as "createdAt"
         FROM phase_reports WHERE id = $1`,
        [id]
      );
      return result.rows[0] ?? null;
    } catch (err) {
      console.warn("[PhaseReportStore] Failed to get:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * List phase reports for a task, ordered by phase number.
   */
  async listByTask(taskId: string): Promise<PhaseReport[]> {
    try {
      if (!this.db.initialized) await this.init();
      const result = await this.db.query<PhaseReport>(
        `SELECT id, task_id as "taskId", phase_number as "phaseNumber", phase_title as "phaseTitle",
                content, tokens, iterations, created_at as "createdAt"
         FROM phase_reports WHERE task_id = $1 ORDER BY phase_number ASC`,
        [taskId]
      );
      return result.rows;
    } catch (err) {
      console.warn("[PhaseReportStore] Failed to listByTask:", err instanceof Error ? err.message : String(err));
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
