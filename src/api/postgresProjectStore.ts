import type { DatabaseClient } from "../db/types.js";
import { createConnection } from "../db/connection.js";
import { StoredProject } from "./projectStore.js";

/**
 * Database-backed project store.
 * Stores project information in a database table instead of a JSON file.
 * Falls back gracefully if the database is unreachable.
 *
 * Accepts a PostgreSQL DatabaseClient instead of creating its own connection.
 */
export class PostgresProjectStore {
  private db: DatabaseClient;

  constructor(db?: DatabaseClient) {
    this.db = db ?? createConnection();
  }

  async init(): Promise<void> {
    if (this.db.initialized) return;
    try {
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          active BOOLEAN DEFAULT FALSE,
          include_in_llm BOOLEAN DEFAULT FALSE,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_projects_active ON projects(active);
      `);
    } catch (err) {
      console.warn("[PostgresProjectStore] Failed to initialize:", err instanceof Error ? err.message : String(err));
    }
  }

  async list(): Promise<StoredProject[]> {
    try {
      if (!this.db.initialized) await this.init();
      const result = await this.db.query<StoredProject>(
        `SELECT id, name, path, active, include_in_llm as "includeInLlm", created_at as "createdAt"
         FROM projects ORDER BY created_at DESC`
      );
      return result.rows;
    } catch (err) {
      console.warn("[PostgresProjectStore] Failed to list:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async get(id: string): Promise<StoredProject | undefined> {
    try {
      if (!this.db.initialized) await this.init();
      const result = await this.db.query<StoredProject>(
        `SELECT id, name, path, active, include_in_llm as "includeInLlm", created_at as "createdAt"
         FROM projects WHERE id = $1`,
        [id]
      );
      return result.rows[0] || undefined;
    } catch (err) {
      console.warn("[PostgresProjectStore] Failed to get:", err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  async add(project: StoredProject): Promise<void> {
    try {
      if (!this.db.initialized) await this.init();
      await this.db.query(
        `INSERT INTO projects (id, name, path, active, include_in_llm, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           path = EXCLUDED.path,
           active = EXCLUDED.active,
           include_in_llm = EXCLUDED.include_in_llm`,
        [project.id, project.name, project.path, !!project.active, !!project.includeInLlm, project.createdAt]
      );
    } catch (err) {
      console.warn("[PostgresProjectStore] Failed to add:", err instanceof Error ? err.message : String(err));
    }
  }

  async update(id: string, updates: Partial<StoredProject>): Promise<void> {
    try {
      if (!this.db.initialized) await this.init();
      const sets: string[] = [];
      const params: unknown[] = [];

      if (updates.name !== undefined) {
        params.push(updates.name);
        sets.push(`name = $${params.length}`);
      }
      if (updates.active !== undefined) {
        params.push(!!updates.active);
        sets.push(`active = $${params.length}`);
      }
      if (updates.includeInLlm !== undefined) {
        params.push(!!updates.includeInLlm);
        sets.push(`include_in_llm = $${params.length}`);
      }
      if (updates.path !== undefined) {
        params.push(updates.path);
        sets.push(`path = $${params.length}`);
      }

      if (sets.length === 0) return;

      params.push(id);
      await this.db.query(
        `UPDATE projects SET ${sets.join(", ")} WHERE id = $${params.length}`,
        params
      );
    } catch (err) {
      console.warn("[PostgresProjectStore] Failed to update:", err instanceof Error ? err.message : String(err));
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      if (!this.db.initialized) await this.init();
      const result = await this.db.query("DELETE FROM projects WHERE id = $1", [id]);
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      console.warn("[PostgresProjectStore] Failed to delete:", err instanceof Error ? err.message : String(err));
      return false;
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
