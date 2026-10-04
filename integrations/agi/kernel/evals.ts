import { randomUUID } from "node:crypto";
import { Agi } from "../src/agi";
import { Sandbox } from "../src/sandbox";
import { publish } from "../src/telemetry";
import { Scenario, ScenarioResult, SuiteReport } from "../src/types";
import { loadScenarios } from "./scenarios";

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** The kernel (not the agent) sets up the world, runs the agent, and judges the outcome with its own check script. */
export async function runScenario(s: Scenario, agi: Agi, sb: Sandbox, learn: boolean): Promise<ScenarioResult> {
  const session = `eval-${s.id}-${randomUUID().slice(0, 6)}`;
  try {
    await sb.reset(session);
    for (const [p, c] of Object.entries(s.files ?? {})) await sb.put(session, p, c);
    for (const cmd of s.setup ?? []) await sb.exec(session, cmd, 30_000);
    const r = await agi.handle(s.task, { runId: `eval-${s.id}`, session, mode: learn ? "practice" : "eval", learn });
    const c = await sb.exec(session, s.check, 30_000);
    return { id: s.id, pass: c.code === 0, steps: r.steps, seconds: r.seconds, tokens: r.tokens, violations: r.violations, status: r.status, note: c.code === 0 ? undefined : (c.stderr || c.stdout).slice(0, 160) };
  } catch (e: any) {
    return { id: s.id, pass: false, steps: 0, seconds: 0, tokens: 0, violations: [], status: "failed", note: String(e?.message ?? e) };
  } finally { await sb.reset(session).catch(() => {}); }
}

export async function runSuites(suites: string[], agi: Agi, sb: Sandbox, opts: { learn?: boolean; label?: string } = {}): Promise<SuiteReport> {
  const all = loadScenarios().filter((s) => s.suites.some((x) => suites.includes(x)));
  const results: ScenarioResult[] = [];
  for (const s of all) {
    if (agi.d.kill.engaged()) break;
    const r = await runScenario(s, agi, sb, !!opts.learn);
    results.push(r);
    publish("eval", { label: opts.label ?? "", genome: agi.d.genome.version, scenario: s.id, pass: r.pass, steps: r.steps, violations: r.violations.length });
  }
  return summarize(agi.d.genome.version, results);
}

export function summarize(genome: string, results: ScenarioResult[]): SuiteReport {
  const n = Math.max(1, results.length);
  return {
    genome, at: Date.now(), results,
    passRate: results.filter((r) => r.pass).length / n,
    medianSteps: median(results.map((r) => r.steps)),
    meanSeconds: results.reduce((a, r) => a + r.seconds, 0) / n,
    violations: results.reduce((a, r) => a + r.violations.length, 0),
    tokens: results.reduce((a, r) => a + r.tokens, 0),
  };
}

/** Fitness: 70% success, 20% efficiency (steps), 10% cost (tokens/scenario). */
export function score(r: SuiteReport): number {
  const n = Math.max(1, r.results.length);
  return +(0.7 * r.passRate + 0.2 * (1 - Math.min(1, r.medianSteps / 12)) + 0.1 * (1 - Math.min(1, r.tokens / n / 40_000))).toFixed(4);
}

export function subset(r: SuiteReport, suite: string): SuiteReport {
  const ids = new Set(loadScenarios().filter((s) => s.suites.includes(suite)).map((s) => s.id));
  return summarize(r.genome, r.results.filter((x) => ids.has(x.id)));
}
