import type { DatabaseClient } from "../db/types.js";
import { createConnection } from "../db/connection.js";

/**
 * Task status within a plan.
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

/**
 * A task within a plan.
 */
export interface PlanTask {
  id: string;
  planId: string;
  description: string;
  status: TaskStatus;
  order: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A plan stored in the database.
 */
export interface Plan {
  id: string;
  taskDescription: string;
  planContent: string;
  status: "active" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

/**
 * Database-backed plan store.
 * Stores plans and their tasks, allowing the LLM to manage task status.
 *
 * Accepts a PostgreSQL DatabaseClient instead of creating its own connection.
 */
export class PlanStore {
  private db: DatabaseClient;

  constructor(db?: DatabaseClient) {
    this.db = db ?? createConnection();
  }

  async init(): Promise<void> {
    if (this.db.initialized) return;
    try {
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS plans (
          id TEXT PRIMARY KEY,
          task_description TEXT NOT NULL,
          plan_content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS plan_tasks (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          task_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan_id ON plan_tasks(plan_id);
        CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
      `);
    } catch (err) {
      console.warn("[PlanStore] Failed to initialize:", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Save a new plan with its tasks.
   */
  async savePlan(taskDescription: string, planContent: string, tasks: string[]): Promise<Plan> {
    await this.init();
    if (!this.db.initialized) {
      throw new Error(
        "PlanStore is not initialized — the database is unreachable. " +
        "Check your DATABASE_URL / DATABASE_HOST connection settings."
      );
    }
    const id = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    try {
      // Insert the plan
      await this.db.query(
        `INSERT INTO plans (id, task_description, plan_content, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', $4, $5)`,
        [id, taskDescription, planContent, now, now]
      );

      // Insert each task
      for (let i = 0; i < tasks.length; i++) {
        const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${i}`;
        await this.db.query(
          `INSERT INTO plan_tasks (id, plan_id, description, status, task_order, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', $4, $5, $6)`,
          [taskId, id, tasks[i], i, now, now]
        );
      }

      return { id, taskDescription, planContent, status: "active", createdAt: now, updatedAt: now };
    } catch (err) {
      console.warn("[PlanStore] Failed to save plan:", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Get a plan by ID.
   */
  async getPlan(id: string): Promise<{ plan: Plan | null; tasks: PlanTask[] }> {
    await this.init();
    if (!this.db.initialized) {
      console.warn("[PlanStore] Not initialized — returning null plan.");
      return { plan: null, tasks: [] };
    }
    try {
      const planResult = await this.db.query<Plan>(
        `SELECT id, task_description as "taskDescription", plan_content as "planContent",
                status, created_at as "createdAt", updated_at as "updatedAt"
         FROM plans WHERE id = $1`,
        [id]
      );

      if (planResult.rows.length === 0) return { plan: null, tasks: [] };

      const tasksResult = await this.db.query<PlanTask>(
        `SELECT id, plan_id as "planId", description, status, task_order as "order",
                created_at as "createdAt", updated_at as "updatedAt"
         FROM plan_tasks WHERE plan_id = $1 ORDER BY task_order ASC`,
        [id]
      );

      return { plan: planResult.rows[0], tasks: tasksResult.rows };
    } catch (err) {
      console.warn("[PlanStore] Failed to get plan:", err instanceof Error ? err.message : String(err));
      return { plan: null, tasks: [] };
    }
  }

  /**
   * List all plans.
   */
  async listPlans(limit = 20): Promise<Plan[]> {
    await this.init();
    if (!this.db.initialized) {
      console.warn("[PlanStore] Not initialized — returning empty plan list.");
      return [];
    }
    try {
      const result = await this.db.query<Plan>(
        `SELECT id, task_description as "taskDescription", plan_content as "planContent",
                status, created_at as "createdAt", updated_at as "updatedAt"
         FROM plans ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      return result.rows;
    } catch (err) {
      console.warn("[PlanStore] Failed to list plans:", err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /**
   * Update a task's status.
   */
  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<boolean> {
    await this.init();
    try {
      const now = new Date().toISOString();
      const result = await this.db.query(
        `UPDATE plan_tasks SET status = $1, updated_at = $2 WHERE id = $3`,
        [status, now, taskId]
      );
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      console.warn("[PlanStore] Failed to update task status:", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /**
   * Add a task to a plan.
   */
  async addTask(planId: string, description: string): Promise<PlanTask | null> {
    await this.init();
    try {
      const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      // Get the next order number
      const orderResult = await this.db.query<{ next_order: number }>(
        `SELECT COALESCE(MAX(task_order), -1) + 1 as next_order FROM plan_tasks WHERE plan_id = $1`,
        [planId]
      );
      const nextOrder = orderResult.rows[0]?.next_order ?? 0;

      await this.db.query(
        `INSERT INTO plan_tasks (id, plan_id, description, status, task_order, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', $4, $5, $6)`,
        [id, planId, description, nextOrder, now, now]
      );

      return {
        id,
        planId,
        description,
        status: "pending",
        order: nextOrder,
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      console.warn("[PlanStore] Failed to add task:", err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Delete a task from a plan.
   */
  async deleteTask(taskId: string): Promise<boolean> {
    await this.init();
    try {
      const result = await this.db.query("DELETE FROM plan_tasks WHERE id = $1", [taskId]);
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      console.warn("[PlanStore] Failed to delete task:", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /**
   * Update plan status.
   */
  async updatePlanStatus(planId: string, status: "active" | "completed" | "cancelled"): Promise<boolean> {
    await this.init();
    try {
      const now = new Date().toISOString();
      const result = await this.db.query(
        `UPDATE plans SET status = $1, updated_at = $2 WHERE id = $3`,
        [status, now, planId]
      );
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      console.warn("[PlanStore] Failed to update plan status:", err instanceof Error ? err.message : String(err));
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
