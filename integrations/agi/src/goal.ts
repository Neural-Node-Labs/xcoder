import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR } from "./config";
import { Goal, Kpi } from "./types";
import { publish } from "./telemetry";

export const DEVOPS_GOAL: Goal = {
  id: "devops-v1",
  statement: "Be efficient at DevOps work, keep learning, and execute operations with precision.",
  autonomy: 1,
  constraints: [
    "Never run destructive commands without human approval",
    "Inspect before changing; verify after changing",
    "Prefer reversible, declarative changes",
  ],
  kpis: [
    { name: "task_success_rate", direction: "max", target: 0.95, suite: "golden" },
    { name: "safety_violation_rate", direction: "min", target: 0, suite: "safety" },
    { name: "median_steps_per_task", direction: "min", target: 6, suite: "golden" },
    { name: "mean_time_to_recover_s", direction: "min", target: 120, suite: "incident" },
    { name: "verified_skills", direction: "max", target: 20, suite: "learning" },
  ],
};

export class GoalStore {
  private f = path.join(AGENT_DIR, "goal.json");
  private g: Goal = fs.existsSync(this.f) ? JSON.parse(fs.readFileSync(this.f, "utf8")) : DEVOPS_GOAL;
  get(): Goal { return this.g; }
  private save() { fs.writeFileSync(this.f, JSON.stringify(this.g, null, 2)); publish("goal", { goal: this.g }); }
  set(patch: Partial<Goal>) {
    if (patch.statement) this.g.statement = String(patch.statement).slice(0, 500);
    if (Array.isArray(patch.constraints)) this.g.constraints = patch.constraints.map(String).slice(0, 20);
    if (patch.autonomy !== undefined && [0, 1, 2, 3].includes(patch.autonomy)) this.g.autonomy = patch.autonomy;
    if (Array.isArray(patch.kpis)) for (const k of patch.kpis) { const m = this.g.kpis.find((x) => x.name === k.name); if (m && Number.isFinite(k.target)) m.target = k.target; }
    this.save(); return this.g;
  }
  update(name: string, value: number) {
    const k = this.g.kpis.find((x) => x.name === name); if (k) { k.current = value; k.measuredAt = Date.now(); }
    this.save();
  }
  /** Normalized 0..1 distance from target; unmeasured KPIs count as 0.5. */
  gap(k: Kpi): number {
    if (k.current === undefined) return 0.5;
    if (k.direction === "max") return Math.max(0, Math.min(1, (k.target - k.current) / (k.target || 1)));
    return k.current <= k.target ? 0 : Math.min(1, (k.current - k.target) / Math.max(k.current, 1e-9));
  }
  weakest(): Kpi | null {
    const ranked = [...this.g.kpis].filter((k) => k.suite !== "learning").sort((a, b) => this.gap(b) - this.gap(a));
    return ranked[0] && this.gap(ranked[0]) > 0 ? ranked[0] : null;
  }
}
