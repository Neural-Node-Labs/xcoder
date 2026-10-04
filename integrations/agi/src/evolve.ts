import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR, CONTROL_DIR, EVOLVE_APPROVAL, EVOLVE_EPSILON } from "./config";
import { Agi } from "./agi";
import { Genome, Evolution, SuiteReport } from "./types";
import { FIXED_PROMPTS, applyChanges, validateGenome, DEFAULT_GENOME } from "./genome";
import { span, publish } from "./telemetry";
import { loadScenarios } from "../kernel/scenarios";
import { runSuites, score, subset } from "../kernel/evals";
import { evaluateGates } from "../kernel/gates";

const SUITES = ["golden", "safety"];
const ALLOWED_TOP = ["params", "prompts"];

export class Evolver {
  private file = path.join(AGENT_DIR, "evolutions.json");
  private evs: Evolution[] = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : [];
  running = false;
  constructor(private agi: Agi, private makeAgi: (g: Genome) => Agi) { this.reconcile(); }

  list() { return [...this.evs].reverse(); }
  private save(e: Evolution, note?: string) {
    e.updatedAt = Date.now(); if (note) e.note = note;
    if (!this.evs.includes(e)) this.evs.push(e);
    fs.writeFileSync(this.file, JSON.stringify(this.evs, null, 1));
    publish("evolution", { evolution: e });
  }

  /** After a restart, learn the supervisor's verdict on any promotion that was in flight. */
  reconcile() {
    for (const e of this.evs.filter((x) => x.status === "promoting")) {
      const f = path.join(CONTROL_DIR, "results", `${e.id}.json`);
      if (!fs.existsSync(f)) continue;
      const r = JSON.parse(fs.readFileSync(f, "utf8"));
      e.status = r.status === "promoted" ? "promoted" : r.status === "rolled_back" ? "rolled_back" : "failed";
      this.save(e, r.reason || `supervisor: ${r.status}`);
    }
  }

  private nextVersion(): string {
    const seen = [DEFAULT_GENOME.version, ...this.evs.map((e) => e.id)];
    for (const d of [path.join(CONTROL_DIR, "releases"), path.join(AGENT_DIR, "releases")]) if (fs.existsSync(d)) seen.push(...fs.readdirSync(d));
    const n = Math.max(...seen.map((v) => Number(/^v(\d{4})$/.exec(v)?.[1] ?? 0)));
    return "v" + String(n + 1).padStart(4, "0");
  }

  /** Measure all KPIs by running the kernel's golden + safety suites against the live genome. Cached per genome version. */
  async baseline(force = false): Promise<SuiteReport> {
    const f = path.join(AGENT_DIR, `baseline-${this.agi.d.genome.version}.json`);
    if (!force && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
    const rep = await span("evolve.baseline", { "agi.genome": this.agi.d.genome.version }, () => runSuites(SUITES, this.agi, this.agi.d.sandbox, { label: "baseline" }));
    fs.writeFileSync(f, JSON.stringify(rep));
    this.applyKpis(rep);
    return rep;
  }

  applyKpis(rep: SuiteReport) {
    const g = this.agi.d.goal, golden = subset(rep, "golden"), safety = subset(rep, "safety"), inc = subset(rep, "incident");
    g.update("task_success_rate", +golden.passRate.toFixed(3));
    g.update("safety_violation_rate", +(safety.results.filter((r) => r.violations.length || !r.pass).length / Math.max(1, safety.results.length)).toFixed(3));
    g.update("median_steps_per_task", golden.medianSteps);
    g.update("mean_time_to_recover_s", +inc.meanSeconds.toFixed(1));
    g.update("verified_skills", this.agi.d.memory.skillCount());
  }

  async cycle(): Promise<Evolution> {
    if (this.running) throw new Error("an evolution cycle is already running");
    this.running = true;
    const base = this.agi.d.genome;
    const ev: Evolution = { id: this.nextVersion(), createdAt: Date.now(), updatedAt: Date.now(), status: "proposing", tier: "T0", targetKpi: "", rationale: "", baseVersion: base.version, candidate: null, changes: null, gates: [] };
    try {
      return await span("evolve.cycle", { "evolve.id": ev.id, "evolve.base": base.version }, async () => {
        const baseline = await this.baseline();
        const target = this.agi.d.goal.weakest();
        ev.targetKpi = target?.name ?? "task_success_rate";
        this.save(ev, `diagnosing ${ev.targetKpi}`);

        // PROPOSE
        const failing = baseline.results.filter((r) => !r.pass || r.violations.length).map((r) => ({ id: r.id, note: r.note, violations: r.violations, task: loadScenarios().find((s) => s.id === r.id)?.task }));
        const out = await span("evolve.propose", {}, () => this.agi.d.llm.ask("evolve", FIXED_PROMPTS.evolve,
          `TARGET KPI: ${ev.targetKpi}\nCURRENT GENOME: ${JSON.stringify({ params: base.params, prompts: base.prompts })}\nFAILING SCENARIOS: ${JSON.stringify(failing)}\nRECENT LESSONS: ${JSON.stringify(this.agi.d.memory.episodes(8))}`, "hard"));
        ev.rationale = String(out.json.rationale ?? "").slice(0, 500);
        ev.changes = out.json.changes ?? {};
        const badKeys = Object.keys(ev.changes).filter((k) => !ALLOWED_TOP.includes(k));
        const changeError = badKeys.length ? `forbidden change keys: ${badKeys.join(",")}` : null;
        const cand = applyChanges(base, ev.changes, ev.id);
        ev.candidate = { params: cand.params, promptsChanged: Object.keys(ev.changes.prompts ?? {}) };
        ev.tier = ev.candidate.promptsChanged.length ? "T1" : "T0";
        if (!Object.keys(ev.changes.params ?? {}).length && !ev.candidate.promptsChanged.length) { ev.status = "failed"; this.save(ev, "proposal contained no usable change"); return ev; }

        // TEST in sandbox with a candidate agent instance (separate genome, same isolated sandbox)
        ev.status = "testing"; this.save(ev, "running golden + safety suites on the candidate");
        const genomeError = validateGenome(cand);
        let rep: SuiteReport;
        if (genomeError) rep = { ...baseline, results: [], passRate: 0, violations: 0 };
        else rep = await span("evolve.eval", { "evolve.id": ev.id }, () => runSuites(SUITES, this.makeAgi(cand), this.agi.d.sandbox, { label: ev.id }));

        // GATES
        const g = await span("evolve.gate", {}, async (s) => {
          const r = evaluateGates(baseline, rep, genomeError, changeError, EVOLVE_EPSILON);
          s.setAttribute("gate.ok", r.ok); return r;
        });
        ev.gates = g.gates; ev.baselineScore = g.bs; ev.candidateScore = g.cs;
        if (!g.ok) { ev.status = "rejected"; this.save(ev, "failed gates; nothing changed"); return ev; }

        if (EVOLVE_APPROVAL === "always" || (EVOLVE_APPROVAL === "prompts" && ev.tier === "T1")) {
          ev.status = "awaiting_approval"; this.save(ev, "gates passed; waiting for human approval"); return ev;
        }
        return this.promote(ev, cand);
      });
    } catch (e: any) {
      ev.status = "failed"; this.save(ev, String(e?.message ?? e)); return ev;
    } finally { this.running = false; }
  }

  private promote(ev: Evolution, cand: Genome): Evolution {
    const dir = path.join(AGENT_DIR, "releases", ev.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "genome.json"), JSON.stringify(cand, null, 2));
    fs.writeFileSync(path.join(AGENT_DIR, "promote.json"), JSON.stringify({ id: ev.id, at: Date.now() }));
    ev.status = "promoting";
    this.save(ev, "requested promotion; supervisor will swap, run probation smoke evals, and roll back on failure");
    return ev;
  }

  approve(id: string): Evolution | null {
    const ev = this.evs.find((e) => e.id === id);
    if (!ev || ev.status !== "awaiting_approval") return null;
    return this.promote(ev, applyChanges(this.agi.d.genome, ev.changes, ev.id));
  }
  reject(id: string) {
    const ev = this.evs.find((e) => e.id === id);
    if (!ev || ev.status !== "awaiting_approval") return null;
    ev.status = "rejected"; this.save(ev, "rejected by human"); return ev;
  }
}
