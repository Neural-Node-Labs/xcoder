import { span, publish } from "./telemetry";
import { FIXED_PROMPTS } from "./genome";
import { Genome, Task, Tier } from "./types";
import { LlmClient } from "./llm";
import { Sandbox } from "./sandbox";
import { Memory } from "./memory";
import { Policy } from "./policy";
import { Approvals, KillSwitch } from "./control";
import { GoalStore } from "./goal";
import { runTool, TOOL_HELP, TOOL_NAMES } from "./tools";

export class Halt extends Error {}
export type Mode = "chat" | "eval" | "practice";

export interface Deps {
  genome: Genome; llm: LlmClient; sandbox: Sandbox; memory: Memory; policy: Policy;
  approvals: Approvals; kill: KillSwitch; goal: GoalStore;
}
export interface RunOpts { runId: string; session: string; mode: Mode; learn?: boolean; history?: { role: string; text: string }[] }
export interface RunResult {
  answer: string; status: "success" | "failed" | "halted"; steps: number; tokens: number;
  seconds: number; violations: string[]; commands: string[];
}
interface State {
  t0: number; tokens: number; steps: number; violations: string[]; commands: string[];
  mode: Mode; session: string; runId: string; autonomy: number; budget: { tokens: number; steps: number; ms: number };
}
const BUDGETS = {
  chat: { tokens: 250_000, steps: 40, ms: 300_000 },
  practice: { tokens: 150_000, steps: 30, ms: 240_000 },
  eval: { tokens: 120_000, steps: 25, ms: 180_000 },
};

/** Loop: Observe(recall) -> Plan -> [Policy -> Simulate -> Approve -> Act -> Verify] per task -> Reflect -> Learn */
export class Agi {
  constructor(public d: Deps) {}
  private get g() { return this.d.genome; }

  private guard(st: State) {
    if (this.d.kill.engaged()) throw new Halt("kill switch engaged");
    if (st.tokens > st.budget.tokens) throw new Halt("token budget exceeded");
    if (st.steps > st.budget.steps) throw new Halt("step budget exceeded");
    if (Date.now() - st.t0 > st.budget.ms) throw new Halt("time budget exceeded");
  }

  private async ask(st: State, role: string, user: string, tier: Tier = this.g.params.defaultTier) {
    this.guard(st);
    const system = (this.g.prompts as any)[role] ?? (FIXED_PROMPTS as any)[role];
    const r = await this.d.llm.ask(role, system, user, tier);
    st.tokens += r.tokens;
    return r.json;
  }

  async handle(message: string, o: RunOpts): Promise<RunResult> {
    const st: State = {
      t0: Date.now(), tokens: 0, steps: 0, violations: [], commands: [], mode: o.mode, session: o.session,
      runId: o.runId, autonomy: this.d.goal.get().autonomy, budget: BUDGETS[o.mode],
    };
    const learn = o.learn ?? o.mode !== "eval";
    return span("agi.run", { "agi.run_id": o.runId, "agi.mode": o.mode, "agi.goal": this.d.goal.get().id, "agi.genome": this.g.version, "agi.message": message },
      async (sp) => {
        let status: RunResult["status"] = "failed";
        let answer = "";
        const results: Record<string, string> = {};
        try {
          const mem = this.d.memory.recall(message, this.g.params.memoryTopK);
          const ctx =
            `MESSAGE: ${message}\nHISTORY: ${JSON.stringify((o.history ?? []).slice(-6))}\n` +
            `GOAL: ${this.d.goal.get().statement}\nCONSTRAINTS: ${JSON.stringify(this.d.goal.get().constraints)}\n` +
            `<memory>${JSON.stringify(mem)}</memory>`;
          const plan = await span("agi.plan", {}, async (s) => {
            const p = await this.ask(st, "planner", ctx, this.g.params.plannerTier);
            s.setAttribute("agi.plan.tasks", (p.tasks ?? []).length);
            return p;
          });
          if (typeof plan.answer === "string" && !(plan.tasks ?? []).length) { answer = plan.answer; status = "success"; }
          else {
            let tasks: Task[] = (plan.tasks ?? []).slice(0, 6);
            let ok = false;
            for (let replan = 0; replan <= this.g.params.maxReplans && tasks.length; replan++) {
              let failed: { t: Task; why: string } | null = null;
              for (const t of tasks) {
                if (t.id in results) continue;
                const r = await this.runTask(st, t, results);
                if (r.ok) results[t.id] = r.output; else { failed = { t, why: r.output }; break; }
              }
              if (!failed) { ok = true; break; }
              if (replan === this.g.params.maxReplans) break;
              publish("replan", { runId: o.runId, why: failed.why.slice(0, 200) });
              const np = await this.ask(st, "planner", `${ctx}\nCOMPLETED: ${JSON.stringify(results).slice(0, 1500)}\nFAILED TASK: ${failed.t.goal}\nREASON: ${failed.why.slice(0, 500)}\nPlan a different approach.`, this.g.params.plannerTier);
              tasks = (np.tasks ?? []).slice(0, 6).map((t: Task, i: number) => ({ ...t, id: `r${replan + 1}_${i + 1}`, deps: [] }));
            }
            const vals = Object.values(results);
            if (ok) {
              answer = vals.length === 1 ? vals[0] : (await this.ask(st, "synth", `MESSAGE: ${message}\nRESULTS: ${JSON.stringify(results).slice(0, 3000)}`)).answer ?? vals.join("\n");
              status = "success";
            } else answer = `I could not complete this. Progress: ${vals.join(" | ").slice(0, 600) || "none"}`;
          }
        } catch (e: any) {
          if (e instanceof Halt) { status = "halted"; answer = `Stopped: ${e.message}`; }
          else { status = "failed"; answer = `Error: ${String(e?.message ?? e)}`; }
        }
        if (learn && status !== "halted") await this.learn(st, message, status, results).catch(() => {});
        sp.setAttribute("agi.status", status); sp.setAttribute("agi.tokens", st.tokens); sp.setAttribute("agi.steps", st.steps);
        return { answer, status, steps: st.steps, tokens: st.tokens, seconds: (Date.now() - st.t0) / 1000, violations: st.violations, commands: st.commands };
      });
  }

  private runTask(st: State, task: Task, results: Record<string, string>): Promise<{ ok: boolean; output: string }> {
    return span("agi.task", { "agi.task.goal": task.goal }, async () => {
      let feedback = "", last = "";
      for (let attempt = 1; attempt <= this.g.params.maxAttempts; attempt++) {
        const ex = await this.execute(st, task, results, feedback);
        last = ex.result;
        if (ex.result.startsWith("ERROR:")) { feedback = ex.result; continue; }
        const v = await span("agi.verify", { "agi.attempt": attempt }, async (s) => {
          const r = await this.ask(st, "critic", `TASK: ${task.goal}\nRESULT: ${ex.result}\nEVIDENCE: ${JSON.stringify(ex.hist.slice(-4)).slice(0, 2500)}`, "medium");
          s.setAttribute("verify.pass", !!r.pass); return r;
        });
        if (v.pass) return { ok: true, output: ex.result };
        feedback = (v.issues ?? []).join("; ") || "critic rejected the result";
      }
      return { ok: false, output: `${last} | ${feedback}` };
    });
  }

  private async execute(st: State, task: Task, results: Record<string, string>, feedback: string) {
    const mem = this.d.memory.recall(task.goal, this.g.params.memoryTopK);
    const skills = mem.skills.map((s) => ({ name: s.name, description: s.description }));
    const hist: { tool: string; args: any; out: string }[] = [];
    const tier = (task.difficulty ?? this.g.params.defaultTier) as Tier;
    for (let i = 0; i < this.g.params.maxStepsPerTask; i++) {
      st.steps++;
      const prompt =
        `TASK: ${task.goal}\nDEPENDENCY RESULTS: ${JSON.stringify(results).slice(0, 1200)}\n` +
        `TOOLS: ${JSON.stringify(TOOL_HELP)}\nSKILLS: ${JSON.stringify(skills)}\n<memory>${JSON.stringify(mem.episodes)}</memory>\n` +
        `FEEDBACK FROM PRIOR ATTEMPT: ${feedback}\nSTEP: ${i}\n` +
        hist.slice(-4).map((h) => `<observation tool="${h.tool}" args=${JSON.stringify(h.args).slice(0, 300)}>\n${h.out.replace(/<\/?observation[^>]*>/g, "")}\n</observation>`).join("\n");
      const step = await this.ask(st, "executor", prompt, tier);
      if (step.final !== undefined) return { result: String(step.final), hist };
      if (!TOOL_NAMES.includes(step.tool)) { hist.push({ tool: "error", args: {}, out: "Invalid reply: provide a valid tool or a final." }); continue; }
      hist.push({ tool: step.tool, args: step.args ?? {}, out: await this.act(st, step.tool, step.args ?? {}) });
    }
    return { result: "ERROR: step limit reached without a final answer", hist };
  }

  private act(st: State, tool: string, args: Record<string, any>): Promise<string> {
    return span("agi.tool", { "tool.name": tool, "agi.env": "sandbox", "tool.args": args }, async (sp) => {
      const v = this.d.policy.check(tool, args, st.autonomy);
      sp.addEvent("policy", { verdict: v.kind, reason: v.reason });
      const text = tool === "bash" ? String(args.cmd ?? "") : `${tool} ${JSON.stringify(args)}`;
      if (v.kind === "deny") { st.violations.push(`${v.reason}: ${text.slice(0, 120)}`); return `POLICY DENIED (${v.reason}). Choose a safer approach.`; }
      if (v.kind === "approve") {
        const sim = await span("agi.simulate", {}, async () => this.ask(st, "simulate", `ACTION: ${tool} ${JSON.stringify(args)}\nREASON FLAGGED: ${v.reason}`, "easy"));
        const ok = st.mode === "chat"
          ? await this.d.approvals.request({ runId: st.runId, tool, args, reason: v.reason, prediction: sim })
          : false;
        if (!ok) return `BLOCKED: ${v.reason}. ${st.mode === "chat" ? "A human declined or did not respond." : "Approval is unavailable in this mode."} Use a non-destructive alternative.`;
      }
      st.commands.push(text.slice(0, 300));
      try {
        const out = await runTool(this.d.sandbox, this.d.memory, st.session, tool, args);
        sp.setAttribute("tool.output_len", out.length);
        return out;
      } catch (e: any) { return `ERROR: ${String(e?.message ?? e)}`; }
    });
  }

  /** Reflect -> episodic lesson; verified skill acquisition from successful multi-command runs. */
  private async learn(st: State, message: string, status: string, results: Record<string, string>) {
    await span("agi.learn", {}, async (sp) => {
      const r = await this.ask(st, "reflect", `MESSAGE: ${message}\nSTATUS: ${status}\nRESULTS: ${JSON.stringify(results).slice(0, 1200)}\nVIOLATIONS: ${JSON.stringify(st.violations)}`, "easy");
      if (r.lesson) this.d.memory.addEpisode(`[${status}] ${message.slice(0, 160)} -> ${r.lesson}`, { status });
      if (status === "success" && st.commands.length >= 2) {
        const s = await this.ask(st, "skill", `COMMANDS:\n${st.commands.join("\n")}`, "medium");
        if (s.save) {
          const res = await this.d.memory.saveSkillVerified(this.d.sandbox, s);
          sp.addEvent("skill", { name: s.name ?? "?", saved: res.saved, detail: res.detail });
          if (res.saved) publish("skill", { name: s.name });
        }
      }
    });
  }
}
