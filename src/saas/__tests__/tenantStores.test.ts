import { describe, it, expect, vi, beforeAll } from "vitest";
import type { DatabaseClient, QueryResult } from "../../db/types.js";

vi.stubEnv("XCODER_SAAS_MODE", "true");

/** Minimal in-memory SQL stand-in: understands only the statements these stores issue, and APPLIES the tenant_id predicate the way Postgres would. */
class FakeDb implements DatabaseClient {
  initialized = true;
  wbs: any[] = []; reports: any[] = []; plans: any[] = []; tasks: any[] = [];
  async init() {}
  async close() {}
  async query<T = any>(sql: string, p: unknown[] = []): Promise<QueryResult<T>> {
    const q = sql.replace(/\s+/g, " ").trim();
    const ok = (rows: any[] = [], rowCount = rows.length) => ({ rows: rows as T[], rowCount });
    if (q.startsWith("INSERT INTO wbs_entries")) { this.wbs.push({ id: p[0], taskId: p[1], phaseNumber: p[3], status: p[5], tenant: p[8] }); return ok([], 1); }
    if (q.startsWith("SELECT") && q.includes("FROM wbs_entries WHERE task_id")) return ok(this.wbs.filter((r) => r.taskId === p[0] && r.tenant === p[1]));
    if (q.startsWith("SELECT") && q.includes("FROM wbs_entries WHERE id")) return ok(this.wbs.filter((r) => r.id === p[0] && r.tenant === p[1]));
    if (q.startsWith("UPDATE wbs_entries")) { const m = this.wbs.filter((r) => r.taskId === p[2] && r.phaseNumber === p[3] && r.tenant === p[4]); m.forEach((r) => (r.status = p[0])); return ok([], m.length); }
    if (q.startsWith("INSERT INTO phase_reports")) { this.reports.push({ id: p[0], taskId: p[1], content: p[4], tenant: p[8] }); return ok([], 1); }
    if (q.startsWith("SELECT") && q.includes("FROM phase_reports WHERE id")) return ok(this.reports.filter((r) => r.id === p[0] && r.tenant === p[1]));
    if (q.startsWith("SELECT") && q.includes("FROM phase_reports WHERE task_id")) return ok(this.reports.filter((r) => r.taskId === p[0] && r.tenant === p[1]));
    if (q.startsWith("INSERT INTO plans ")) { this.plans.push({ id: p[0], tenant: p[5] }); return ok([], 1); }
    if (q.startsWith("INSERT INTO plan_tasks") && q.includes("VALUES")) { this.tasks.push({ id: p[0], planId: p[1], tenant: p[6] }); return ok([], 1); }
    if (q.startsWith("INSERT INTO plan_tasks") && q.includes("SELECT")) { if (this.plans.some((x) => x.id === p[1] && x.tenant === p[6])) { this.tasks.push({ id: p[0], planId: p[1], tenant: p[6] }); return ok([], 1); } return ok([], 0); }
    if (q.includes("FROM plans WHERE id")) return ok(this.plans.filter((r) => r.id === p[0] && r.tenant === p[1]));
    if (q.includes("FROM plan_tasks WHERE plan_id") && q.includes("MAX")) return ok([{ next_order: 0 }]);
    if (q.includes("FROM plan_tasks WHERE plan_id")) return ok(this.tasks.filter((r) => r.planId === p[0] && r.tenant === p[1]));
    if (q.includes("FROM plans WHERE tenant_id")) return ok(this.plans.filter((r) => r.tenant === p[1]));
    if (q.startsWith("DELETE FROM plan_tasks")) { const n = this.tasks.length; this.tasks = this.tasks.filter((r) => !(r.id === p[0] && r.tenant === p[1])); return ok([], n - this.tasks.length); }
    throw new Error("unexpected SQL: " + q.slice(0, 80));
  }
}

let runWithTenant: typeof import("../context.js").runWithTenant;
let WbsStore: typeof import("../../api/wbsStore.js").WbsStore, PhaseReportStore: typeof import("../../api/phaseReportStore.js").PhaseReportStore, PlanStore: typeof import("../../api/planStore.js").PlanStore;
beforeAll(async () => {
  ({ runWithTenant } = await import("../context.js"));
  ({ WbsStore } = await import("../../api/wbsStore.js")); ({ PhaseReportStore } = await import("../../api/phaseReportStore.js")); ({ PlanStore } = await import("../../api/planStore.js"));
});
const as = <T>(tenantId: string, fn: () => T) => runWithTenant({ tenantId, userId: "u", role: "tenant_user", features: new Set() }, fn);

describe("DB-backed stores are tenant-scoped", () => {
  it("WBS entries: a tenant cannot list, read or update another tenant's rows", async () => {
    const db = new FakeDb(), s = new WbsStore(db);
    await as("a", () => s.saveBatch([{ taskId: "t1", taskDescription: "d", phaseNumber: 1, phaseTitle: "P", status: "pending" }]));
    const id = db.wbs[0].id;
    expect(await as("a", () => s.listByTask("t1"))).toHaveLength(1);
    expect(await as("b", () => s.listByTask("t1"))).toHaveLength(0);
    expect(await as("b", () => s.get(id))).toBeNull();
    expect(await as("b", () => s.updateStatus("t1", 1, "completed"))).toBe(false);
    expect(db.wbs[0].status).toBe("pending");
    expect(await as("a", () => s.updateStatus("t1", 1, "completed"))).toBe(true);
  });
  it("phase reports are isolated", async () => {
    const db = new FakeDb(), s = new PhaseReportStore(db);
    const r = await as("a", () => s.save({ taskId: "t1", phaseNumber: 1, phaseTitle: "P", content: "secret", tokens: 1, iterations: 1 }));
    expect(await as("b", () => s.get(r!.id))).toBeNull();
    expect(await as("b", () => s.listByTask("t1"))).toEqual([]);
    expect((await as("a", () => s.get(r!.id)))?.id).toBe(r!.id);
  });
  it("plans and plan tasks are isolated, incl. adding/deleting tasks on another tenant's plan", async () => {
    const db = new FakeDb(), s = new PlanStore(db);
    const plan = await as("a", () => s.savePlan("x", "y", ["one"]));
    expect((await as("b", () => s.getPlan(plan.id))).plan).toBeNull();
    expect(await as("b", () => s.listPlans())).toEqual([]);
    expect(await as("b", () => s.addTask(plan.id, "evil"))).toBeNull();
    expect(db.tasks).toHaveLength(1);
    expect(await as("b", () => s.deleteTask(db.tasks[0].id))).toBe(false);
    expect(await as("a", () => s.listPlans())).toHaveLength(1);
  });
  it("fails closed with no tenant scope in SaaS mode (nothing is written or returned)", async () => {
    const db = new FakeDb(), s = new WbsStore(db);
    expect(await s.saveBatch([{ taskId: "t", taskDescription: "d", phaseNumber: 1, phaseTitle: "P", status: "pending" }])).toBe(false);
    expect(db.wbs).toHaveLength(0);
    expect(await s.listByTask("t")).toEqual([]);
  });
});
