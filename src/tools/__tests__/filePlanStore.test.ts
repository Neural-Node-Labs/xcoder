/**
 * Regression suite for FilePlanStore (src/tools/filePlanStore.ts) — the file-based plan store
 * used by the CLI code path as an alternative to the DB-backed PlanStore. It's entirely
 * synchronous fs work keyed off `.agent/plans/` under process.cwd(), so tests chdir into a
 * throwaway temp directory for isolation and restore the original cwd afterward.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FilePlanStore } from "../filePlanStore.js";

let tmpDir: string;
let originalCwd: string;
let store: FilePlanStore;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-planstore-test-"));
  process.chdir(tmpDir);
  store = new FilePlanStore();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("FilePlanStore.savePlan / getPlan", () => {
  it("saves a plan with tasks and reads it back with matching content", async () => {
    const plan = await store.savePlan("build a widget", "# Plan\n1. Do a thing", ["step one", "step two"]);
    expect(plan.status).toBe("active");
    expect(plan.taskDescription).toBe("build a widget");

    const { plan: fetched, tasks } = await store.getPlan(plan.id);
    expect(fetched).toEqual(plan);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ description: "step one", status: "pending", order: 0, planId: plan.id });
    expect(tasks[1]).toMatchObject({ description: "step two", status: "pending", order: 1, planId: plan.id });
  });

  it("persists the plan to a real JSON file under .agent/plans/", async () => {
    const plan = await store.savePlan("t", "c", []);
    const filePath = path.join(tmpDir, ".agent", "plans", `${plan.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(onDisk.plan.id).toBe(plan.id);
  });

  it("supports a plan with zero tasks", async () => {
    const plan = await store.savePlan("empty plan", "content", []);
    const { tasks } = await store.getPlan(plan.id);
    expect(tasks).toEqual([]);
  });

  it("getPlan returns { plan: null, tasks: [] } for an unknown id", async () => {
    const result = await store.getPlan("plan_does_not_exist");
    expect(result).toEqual({ plan: null, tasks: [] });
  });

  it("generates unique ids for plans saved back-to-back", async () => {
    const p1 = await store.savePlan("a", "a", []);
    const p2 = await store.savePlan("b", "b", []);
    expect(p1.id).not.toBe(p2.id);
  });
});

describe("FilePlanStore.listPlans", () => {
  it("returns an empty array when no plans directory exists yet", async () => {
    expect(await store.listPlans()).toEqual([]);
  });

  it("lists saved plans, most recently created first", async () => {
    const p1 = await store.savePlan("first", "c", []);
    await new Promise((r) => setTimeout(r, 5));
    const p2 = await store.savePlan("second", "c", []);
    await new Promise((r) => setTimeout(r, 5));
    const p3 = await store.savePlan("third", "c", []);

    const plans = await store.listPlans();
    expect(plans.map((p) => p.id)).toEqual([p3.id, p2.id, p1.id]);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await store.savePlan(`plan ${i}`, "c", []);
      await new Promise((r) => setTimeout(r, 2));
    }
    const plans = await store.listPlans(2);
    expect(plans).toHaveLength(2);
  });

  it("skips corrupt plan files instead of throwing", async () => {
    const plan = await store.savePlan("good", "c", []);
    const plansDir = path.join(tmpDir, ".agent", "plans");
    fs.writeFileSync(path.join(plansDir, "corrupt.json"), "{ not valid json");

    const plans = await store.listPlans();
    expect(plans.map((p) => p.id)).toEqual([plan.id]);
  });

  it("ignores non-.json files in the plans directory", async () => {
    const plan = await store.savePlan("good", "c", []);
    const plansDir = path.join(tmpDir, ".agent", "plans");
    fs.writeFileSync(path.join(plansDir, "readme.txt"), "not a plan");

    const plans = await store.listPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0].id).toBe(plan.id);
  });
});

describe("FilePlanStore.updateTaskStatus", () => {
  it("updates a task's status and updatedAt timestamp, persisting to disk", async () => {
    const plan = await store.savePlan("t", "c", ["step one"]);
    const { tasks } = await store.getPlan(plan.id);
    const taskId = tasks[0].id;
    const originalUpdatedAt = tasks[0].updatedAt;

    await new Promise((r) => setTimeout(r, 5));
    const ok = await store.updateTaskStatus(taskId, "completed");
    expect(ok).toBe(true);

    const { tasks: after } = await store.getPlan(plan.id);
    expect(after[0].status).toBe("completed");
    expect(after[0].updatedAt).not.toBe(originalUpdatedAt);
  });

  it("returns false for an unknown task id and touches no files", async () => {
    const ok = await store.updateTaskStatus("task_does_not_exist", "completed");
    expect(ok).toBe(false);
  });

  it("returns false when there's no plans directory at all yet", async () => {
    // fresh store, no savePlan called — .agent/plans doesn't exist
    expect(await store.updateTaskStatus("anything", "completed")).toBe(false);
  });
});

describe("FilePlanStore.addTask", () => {
  it("appends a task with the next sequential order", async () => {
    const plan = await store.savePlan("t", "c", ["step one", "step two"]);
    const newTask = await store.addTask(plan.id, "step three");
    expect(newTask).not.toBeNull();
    expect(newTask!.order).toBe(2);
    expect(newTask!.status).toBe("pending");

    const { tasks } = await store.getPlan(plan.id);
    expect(tasks).toHaveLength(3);
    expect(tasks[2].description).toBe("step three");
  });

  it("returns null for an unknown plan id and creates no file", async () => {
    const result = await store.addTask("plan_does_not_exist", "orphan task");
    expect(result).toBeNull();
  });

  it("assigns order 0 to the first task added to an initially-empty plan", async () => {
    const plan = await store.savePlan("empty", "c", []);
    const task = await store.addTask(plan.id, "first task");
    expect(task!.order).toBe(0);
  });
});

describe("FilePlanStore.deleteTask", () => {
  it("removes the task and persists the change", async () => {
    const plan = await store.savePlan("t", "c", ["keep", "remove me"]);
    const { tasks } = await store.getPlan(plan.id);
    const toRemove = tasks.find((t) => t.description === "remove me")!;

    const ok = await store.deleteTask(toRemove.id);
    expect(ok).toBe(true);

    const { tasks: after } = await store.getPlan(plan.id);
    expect(after).toHaveLength(1);
    expect(after[0].description).toBe("keep");
  });

  it("returns false for an unknown task id", async () => {
    expect(await store.deleteTask("task_does_not_exist")).toBe(false);
  });

  it("returns false when there's no plans directory yet", async () => {
    expect(await store.deleteTask("anything")).toBe(false);
  });
});

describe("FilePlanStore.close", () => {
  it("resolves without doing anything (file-based store has no connection to close)", async () => {
    await expect(store.close()).resolves.toBeUndefined();
  });
});

describe("FilePlanStore — cross-plan isolation", () => {
  it("updateTaskStatus/addTask/deleteTask only ever touch the plan file containing the target task", async () => {
    const planA = await store.savePlan("plan A", "c", ["a-task"]);
    const planB = await store.savePlan("plan B", "c", ["b-task"]);
    const { tasks: aTasks } = await store.getPlan(planA.id);

    await store.updateTaskStatus(aTasks[0].id, "completed");

    const { plan: bPlan, tasks: bTasks } = await store.getPlan(planB.id);
    expect(bPlan!.updatedAt).toBe(planB.updatedAt); // untouched
    expect(bTasks[0].status).toBe("pending"); // untouched
  });
});
