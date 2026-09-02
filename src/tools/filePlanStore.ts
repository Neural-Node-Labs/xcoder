import fs from "node:fs";
import path from "node:path";

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
 * A plan stored as a JSON file.
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
 * The on-disk shape: a plan plus its tasks.
 */
interface PlanFile {
  plan: Plan;
  tasks: PlanTask[];
}

const PLANS_DIR = path.join(".agent", "plans");

/**
 * File-based plan store.
 * Stores plans and their tasks as JSON files in .agent/plans/.
 * No database dependency — purely file-based for the CLI code path.
 */
export class FilePlanStore {
  /**
   * Save a new plan with its tasks.
   */
  async savePlan(taskDescription: string, planContent: string, tasks: string[]): Promise<Plan> {
    const id = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const plan: Plan = {
      id,
      taskDescription,
      planContent,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    const planTasks: PlanTask[] = tasks.map((desc, i) => ({
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${i}`,
      planId: id,
      description: desc,
      status: "pending" as TaskStatus,
      order: i,
      createdAt: now,
      updatedAt: now,
    }));

    this.writePlanFile(id, { plan, tasks: planTasks });
    return plan;
  }

  /**
   * Get a plan by ID.
   */
  async getPlan(id: string): Promise<{ plan: Plan | null; tasks: PlanTask[] }> {
    const data = this.readPlanFile(id);
    if (!data) return { plan: null, tasks: [] };
    return { plan: data.plan, tasks: data.tasks };
  }

  /**
   * List all plans.
   */
  async listPlans(limit = 20): Promise<Plan[]> {
    const dir = path.join(process.cwd(), PLANS_DIR);
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, limit);

    const plans: Plan[] = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as PlanFile;
        plans.push(data.plan);
      } catch {
        // skip corrupt files
      }
    }
    return plans;
  }

  /**
   * Update a task's status.
   */
  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<boolean> {
    const found = this.findTaskFile(taskId);
    if (!found) return false;
    const { planFile, data } = found;
    if (!planFile || !data) return false;

    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) return false;

    task.status = status;
    task.updatedAt = new Date().toISOString();
    this.writePlanFile(data.plan.id, data);
    return true;
  }

  /**
   * Add a task to a plan.
   */
  async addTask(planId: string, description: string): Promise<PlanTask | null> {
    const data = this.readPlanFile(planId);
    if (!data) return null;

    const now = new Date().toISOString();
    const nextOrder = data.tasks.length;

    const task: PlanTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      planId,
      description,
      status: "pending",
      order: nextOrder,
      createdAt: now,
      updatedAt: now,
    };

    data.tasks.push(task);
    this.writePlanFile(planId, data);
    return task;
  }

  /**
   * Delete a task from a plan.
   */
  async deleteTask(taskId: string): Promise<boolean> {
    const found = this.findTaskFile(taskId);
    if (!found) return false;
    const { planFile, data } = found;
    if (!planFile || !data) return false;

    const idx = data.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;

    data.tasks.splice(idx, 1);
    this.writePlanFile(data.plan.id, data);
    return true;
  }

  async close(): Promise<void> {
    // No-op for file-based store
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  private planDir(): string {
    const dir = path.join(process.cwd(), PLANS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private planFilePath(id: string): string {
    return path.join(this.planDir(), `${id}.json`);
  }

  private writePlanFile(id: string, data: PlanFile): void {
    fs.writeFileSync(this.planFilePath(id), JSON.stringify(data, null, 2), "utf-8");
  }

  private readPlanFile(id: string): PlanFile | null {
    const fp = this.planFilePath(id);
    if (!fs.existsSync(fp)) return null;
    try {
      return JSON.parse(fs.readFileSync(fp, "utf-8")) as PlanFile;
    } catch {
      return null;
    }
  }

  /**
   * Searches all plan files for one containing a task with the given taskId.
   * Returns the filename and parsed data, or null if not found.
   */
  private findTaskFile(taskId: string): { planFile: string; data: PlanFile } | null {
    const dir = path.join(process.cwd(), PLANS_DIR);
    if (!fs.existsSync(dir)) return null;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as PlanFile;
        if (data.tasks.some((t) => t.id === taskId)) {
          return { planFile: file, data };
        }
      } catch {
        // skip corrupt files
      }
    }
    return null;
  }
}

