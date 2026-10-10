import { startTelemetry, publish } from "./telemetry";
import { LlmClient } from "./llm";
import { Sandbox } from "./sandbox";
import { Memory } from "./memory";
import { Policy } from "./policy";
import { Approvals, KillSwitch } from "./control";
import { GoalStore } from "./goal";
import { Agi } from "./agi";
import { Evolver } from "./evolve";
import { loadGenome } from "./genome";
import { startApi } from "./api";
import { runSuites } from "../kernel/evals";
import { GOAL_LOOP_MINUTES, LLM_MODE } from "./config";
import { Scheduler } from "./scheduler";
import fs from "node:fs";
import { AGENT_DIR } from "./config";

async function main() {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  const sdk = startTelemetry();
  const { genome, release } = loadGenome();
  const shared = { llm: new LlmClient(), sandbox: new Sandbox(), memory: new Memory(), policy: new Policy(), approvals: new Approvals(), kill: new KillSwitch(), goal: new GoalStore() };
  const agi = new Agi({ ...shared, genome });
  const evolver = new Evolver(agi, (g) => new Agi({ ...shared, genome: g }));
  const state = { release, probation: (process.env.PROBATION === "1" ? "pending" : "n/a") as "n/a" | "pending" | "pass" | "fail", busy: 0 };
  setInterval(() => evolver.reconcile(), 3000).unref();
  console.log(`[agent] release=${release} genome=${genome.version} llm=${LLM_MODE} probation=${state.probation}`);


  // Autonomous goal loop, controlled from the UI (Schedule). Each cycle measures KPIs and, if any is off target,
  // runs one evolution cycle. It stops when the daily token allowance is spent and resumes when it refills.
  const scheduler = new Scheduler({
    dir: AGENT_DIR,
    blockedReason: () => shared.kill.engaged() ? "kill switch engaged" : state.probation === "pending" || state.probation === "fail" ? "release on probation" : evolver.running ? "evolution already running" : state.busy ? "agent busy" : null,
    run: async () => {
      await evolver.baseline(true);
      if (!shared.goal.weakest()) return "all KPIs on target";
      const ev = await evolver.cycle();
      return `evolution ${ev.id}: ${ev.status}`;
    },
  });
  if (GOAL_LOOP_MINUTES > 0) console.warn("[agent] GOAL_LOOP_MINUTES is ignored: use the Schedule controls (token-capped) instead");
  startApi({ agi, evolver, goal: shared.goal, approvals: shared.approvals, kill: shared.kill, memory: shared.memory, sandbox: shared.sandbox, state, scheduler, llm: shared.llm });

  // Probation: a freshly promoted release must pass the kernel's smoke evals before the supervisor marks it stable.
  if (state.probation === "pending") {
    for (let i = 0; i < 30 && !(await shared.sandbox.healthy()); i++) await new Promise((r) => setTimeout(r, 1000));
    const rep = await runSuites(["smoke"], agi, shared.sandbox, { label: "probation" });
    state.probation = rep.passRate === 1 && rep.violations === 0 ? "pass" : "fail";
    if (process.env.CHAOS_FAIL_PROBATION === "1") state.probation = "fail"; // chaos toggle: proves automatic rollback works
    publish("probation", { release, result: state.probation });
    console.log(`[agent] probation ${state.probation}`);
  }

  scheduler.start();   // only after probation, so a release that fails probation never runs autonomous cycles
  process.on("SIGTERM", async () => { await sdk.shutdown().catch(() => {}); process.exit(0); });
}
main().catch((e) => { console.error(e); process.exit(1); });
