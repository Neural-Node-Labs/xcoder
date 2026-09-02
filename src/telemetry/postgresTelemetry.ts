import type { DatabaseClient } from "../db/types.js";
import { createConnection } from "../db/connection.js";
import { TelemetryInterface, ReActStep } from "../core/types.js";

/**
 * Database-backed na implementasyon ng telemetry.
 * Iniimbak ang mga ReAct step, LLM call, at error sa mga talahanayan ng database.
 * Maayos na bumabalik sa fallback kung hindi maabot ang database (nagla-log sa console).
 *
 * Tumatanggap ng PostgreSQL DatabaseClient sa halip na gumawa ng sarili nitong koneksyon.
 *
 * Awtomatikong nagagawa ang schema sa unang koneksyon sa pamamagitan ng init().
 */
export class PostgresTelemetry implements TelemetryInterface {
  private db: DatabaseClient;
  private initialized = false;

  constructor(db?: DatabaseClient) {
    this.db = db ?? createConnection();
  }

  /**
   * I-initialize ang database schema. Gagawa ng mga talahanayan kung wala pa ang mga ito.
   * Ligtas na tawagin nang paulit-ulit — gumagamit ng IF NOT EXISTS.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS telemetry_logs (
          id SERIAL PRIMARY KEY,
          task_id TEXT,
          iteration INTEGER,
          phase TEXT,
          thought TEXT,
          action_tool TEXT,
          action_input TEXT,
          observation TEXT,
          score INTEGER,
          timestamp TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS telemetry_llm_calls (
          id SERIAL PRIMARY KEY,
          task_id TEXT,
          request TEXT,
          response TEXT,
          timestamp TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS telemetry_errors (
          id SERIAL PRIMARY KEY,
          task_id TEXT,
          context TEXT,
          error_message TEXT,
          error_stack TEXT,
          timestamp TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_telemetry_logs_task_id ON telemetry_logs(task_id);
        CREATE INDEX IF NOT EXISTS idx_telemetry_logs_timestamp ON telemetry_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_telemetry_llm_calls_task_id ON telemetry_llm_calls(task_id);
        CREATE INDEX IF NOT EXISTS idx_telemetry_errors_task_id ON telemetry_errors(task_id);
      `);
      this.initialized = true;
    } catch (err) {
      console.warn("[PostgresTelemetry] Failed to initialize database schema, using fallback:", err instanceof Error ? err.message : String(err));
    }
  }

  private async query(text: string, params?: unknown[]): Promise<void> {
    try {
      if (!this.initialized) await this.init();
      await this.db.query(text, params);
    } catch (err) {
      // Fallback: mag-log sa console
      console.warn("[PostgresTelemetry] Query failed, falling back:", err instanceof Error ? err.message : String(err));
    }
  }

  async logThought(step: ReActStep): Promise<void> {
    await this.query(
      `INSERT INTO telemetry_logs (task_id, iteration, phase, thought, action_tool, action_input, observation, score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        (step as any).taskId || null,
        step.iteration,
        step.phase,
        step.thought,
        step.action?.tool || null,
        step.action?.input ? JSON.stringify(step.action.input) : null,
        step.observation ? JSON.stringify(step.observation) : null,
        step.score ?? null,
      ]
    );
  }

  async logLlmCall(request: unknown, response: unknown): Promise<void> {
    await this.query(
      `INSERT INTO telemetry_llm_calls (request, response) VALUES ($1, $2)`,
      [JSON.stringify(request), JSON.stringify(response)]
    );
  }

  async logError(err: unknown, context?: string): Promise<void> {
    const serialized = err instanceof Error
      ? { message: err.message, stack: err.stack }
      : { err };
    await this.query(
      `INSERT INTO telemetry_errors (context, error_message, error_stack) VALUES ($1, $2, $3)`,
      [context || null, serialized.message || null, serialized.stack || null]
    );
  }

  /**
   * Kunin ang mga telemetry log para sa isang partikular na task.
   */
  async getLogsForTask(taskId: string, limit = 100): Promise<ReActStep[]> {
    try {
      if (!this.initialized) await this.init();
      const result = await this.db.query<any>(
        `SELECT * FROM telemetry_logs WHERE task_id = $1 ORDER BY timestamp DESC LIMIT $2`,
        [taskId, limit]
      );
      return result.rows.map((row: any) => ({
        iteration: row.iteration,
        phase: row.phase,
        thought: row.thought,
        action: row.action_tool ? { tool: row.action_tool, input: row.action_input } : undefined,
        observation: row.observation,
        score: row.score,
      }));
    } catch (err) {
      console.warn("[PostgresTelemetry] Failed to get logs for task:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /**
   * Kunin ang lahat ng telemetry log na may opsyonal na mga filter.
   */
  async getLogs(opts?: { taskId?: string; limit?: number; offset?: number; logType?: string }): Promise<any[]> {
    try {
      if (!this.initialized) await this.init();
      let query = "SELECT * FROM telemetry_logs WHERE 1=1";
      const params: unknown[] = [];

      if (opts?.taskId) {
        params.push(opts.taskId);
        query += ` AND task_id = $${params.length}`;
      }

      query += " ORDER BY timestamp DESC";

      if (opts?.limit) {
        params.push(opts.limit);
        query += ` LIMIT $${params.length}`;
      } else {
        query += " LIMIT 100";
      }

      if (opts?.offset) {
        params.push(opts.offset);
        query += ` OFFSET $${params.length}`;
      }

      const result = await this.db.query(query, params);
      return result.rows;
    } catch (err) {
      console.warn("[PostgresTelemetry] Failed to get logs:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /**
   * Isara ang koneksyon sa database.
   */
  async close(): Promise<void> {
    try {
      await this.db.close();
    } catch {
      // huwag pansinin ang mga error sa pagsara
    }
  }
}
