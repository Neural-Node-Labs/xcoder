import { Router, Request, Response } from "express";
import { PlanStore } from "./planStore.js";
import { ApiResponse } from "./types.js";

export function registerPlanRoutes(router: Router): void {
  const planStore = new PlanStore();

  // ─── List all plans ──────────────────────────────────────────────────────
  router.get("/plans", async (_req: Request, res: Response) => {
    try {
      const plans = await planStore.listPlans();
      const body: ApiResponse = { success: true, data: { plans } };
      res.json(body);
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  // ─── Get a single plan with its tasks ────────────────────────────────────
  router.get("/plans/:id", async (req: Request, res: Response) => {
    try {
      const { plan, tasks } = await planStore.getPlan(String(req.params.id));
      if (!plan) {
        res.status(404).json({ success: false, error: "Plan not found" } as ApiResponse);
        return;
      }
      const body: ApiResponse = { success: true, data: { plan, tasks } };
      res.json(body);
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  // ─── Save a new plan ─────────────────────────────────────────────────────
  router.post("/plans", async (req: Request, res: Response) => {
    try {
      const { taskDescription, planContent, tasks } = req.body as {
        taskDescription?: string;
        planContent?: string;
        tasks?: string[];
      };

      if (!taskDescription || !planContent) {
        res.status(400).json({ success: false, error: "'taskDescription' and 'planContent' are required" } as ApiResponse);
        return;
      }

      const plan = await planStore.savePlan(taskDescription, planContent, tasks || []);
      res.status(201).json({ success: true, data: { plan } } as ApiResponse);
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  // ─── Update plan status ──────────────────────────────────────────────────
  router.put("/plans/:id/status", async (req: Request, res: Response) => {
    try {
      const { status } = req.body as { status?: "active" | "completed" | "cancelled" };
      if (!status || !["active", "completed", "cancelled"].includes(status)) {
        res.status(400).json({ success: false, error: "'status' must be 'active', 'completed', or 'cancelled'" } as ApiResponse);
        return;
      }
      const updated = await planStore.updatePlanStatus(String(req.params.id), status);
      if (!updated) {
        res.status(404).json({ success: false, error: "Plan not found" } as ApiResponse);
        return;
      }
      res.json({ success: true, data: { updated: true } } as ApiResponse);
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  // ─── Update task status ──────────────────────────────────────────────────
  router.put("/plans/:planId/tasks/:taskId", async (req: Request, res: Response) => {
    try {
      const { status } = req.body as { status?: string };
      if (!status || !["pending", "in_progress", "completed", "failed", "skipped"].includes(status)) {
        res.status(400).json({
          success: false,
          error: "'status' must be 'pending', 'in_progress', 'completed', 'failed', or 'skipped'",
        } as ApiResponse);
        return;
      }
      const updated = await planStore.updateTaskStatus(
        String(req.params.taskId),
        status as any
      );
      if (!updated) {
        res.status(404).json({ success: false, error: "Task not found" } as ApiResponse);
        return;
      }
      res.json({ success: true, data: { updated: true } } as ApiResponse);
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  // ─── Add a task to a plan ────────────────────────────────────────────────
  router.post("/plans/:id/tasks", async (req: Request, res: Response) => {
    try {
      const { description } = req.body as { description?: string };
      if (!description) {
        res.status(400).json({ success: false, error: "'description' is required" } as ApiResponse);
        return;
      }
      const task = await planStore.addTask(String(req.params.id), description);
      if (!task) {
        res.status(404).json({ success: false, error: "Plan not found" } as ApiResponse);
        return;
      }
      res.status(201).json({ success: true, data: { task } } as ApiResponse);
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  // ─── Delete a task from a plan ───────────────────────────────────────────
  router.delete("/plans/:planId/tasks/:taskId", async (req: Request, res: Response) => {
    try {
      const deleted = await planStore.deleteTask(String(req.params.taskId));
      if (!deleted) {
        res.status(404).json({ success: false, error: "Task not found" } as ApiResponse);
        return;
      }
      res.json({ success: true, data: { deleted: true } } as ApiResponse);
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });
}

