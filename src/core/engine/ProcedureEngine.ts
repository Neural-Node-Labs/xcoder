// ronin:version 5 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:47:31.309Z | ronin:subtask code-st-f034f3
// ProcedureEngine — registered as "procedure". TS semantic port of
// the reference Python procedure_workflow: two-step procedure generation (plan -> strict JSON schema),
// then local step execution over the existing tool dispatcher (design D4).
// AC-5 seam: a scripted LlmClient returns a plan then a JSON Procedure with a trivial
// shell step (e.g. "echo done") that stepExecution runs under workspaceRoot.
import { LlmClient, LlmMessage, LlmUsage, LoadedSkill } from "../types.js";
import type { EngineDeps } from "./EngineRegistry.js";
import { AgentIO } from "../io/AgentIO.js";
import { AutoIO } from "../io/AutoIO.js";
import {
  IReactEngine,
  IReactEngineV2,
  RunOptions,
  RunOutcome,
  PartialSuccessContext,
  SubagentLimitContext,
  EngineState,
  ProgressObserver,
} from "./IReactEngine.js";
import { MultiRoleRouter } from "../workflows/router.js";
import { generateProcedure } from "../workflows/procedure.js";
import { executeProcedure } from "../workflows/stepExecution.js";
import { Procedure } from "../workflows/types.js";

/** Procedure generation signature — the AC-5 seam can inject a scripted generator. */
export type ProcedureGenerateFn = (taskDescription: string) => Promise<Procedure>;

/** Engine-specific options: the AC-5 test seam injects a scripted procedure generator. */
interface ProcedureEngineOptions {
  procedureFn?: ProcedureGenerateFn;
}

/**
 * ProcedureEngine — plan-then-JSON procedure generation plus local execution.
 * run() returns the concatenated step outputs as the final answer.
 */
export class ProcedureEngine implements IReactEngine, IReactEngineV2 {
  private llm: LlmClient; // usage-recording proxy over deps.llm
  private router: MultiRoleRouter;
  private workspaceRoot: string;
  private generate: ProcedureGenerateFn;
  private io: AgentIO;

  private observers = new Set<ProgressObserver>();
  private state: EngineState = { phase: "idle" };
  private cancelled = false;
  private lastMessages: LlmMessage[] = [];
  private iterationCount = 0;
  private lastOutcome: RunOutcome = "completed";
  private cumulativeUsage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  private healthScore = 100;

  constructor(deps: EngineDeps) {
    this.workspaceRoot = deps.options?.cwd ?? process.cwd();
    this.io = deps.io ?? new AutoIO();

    // Usage-recording proxy over the injected client so getCumulativeUsage() reflects
    // plan/format/llm_call steps.
    const usage = this.cumulativeUsage;
    const base = deps.llm;
    this.llm = {
      complete: async (messages, opts) => {
        const resp = await base.complete(messages, opts);
        if (resp.usage) {
          usage.promptTokens += resp.usage.promptTokens;
          usage.completionTokens += resp.usage.completionTokens;
          usage.totalTokens += resp.usage.totalTokens;
          usage.reasoningTokens = (usage.reasoningTokens ?? 0) + (resp.usage.reasoningTokens ?? 0);
          usage.cachedTokens = (usage.cachedTokens ?? 0) + (resp.usage.cachedTokens ?? 0);
        }
        return resp;
      },
    };

    // Oracle: the orchestrator role drives both plan and schema calls (mirrors the
    // Python default role="orchestrator"). The executor role backs auto-fix refinements
    // and llm-call steps.
    this.router = new MultiRoleRouter(this.llm, {
      orchestrator: {},
      executor: {},
    });

    const procOpts = deps.options as ProcedureEngineOptions | undefined;
    this.generate =
      procOpts?.procedureFn ??
      ((task) =>
        generateProcedure(task, this.router, {
          role: "orchestrator",
          workspaceRoot: this.workspaceRoot,
        }));
  }

  // ─── IReactEngine ──────────────────────────────────────────────────────────────

  async run(taskDescription: string, _runOpts: RunOptions = {}): Promise<string> {
    this.cancelled = false;
    this.lastOutcome = "completed";
    this.iterationCount = 0;
    this.lastMessages = [];
    this.transition({ phase: "planning", task: taskDescription });

    try {
      this.io.spinnerStart("Generating procedure...");
      let procedure;
      try {
        procedure = await this.generate(taskDescription);
      } finally {
        this.io.spinnerStop();
      }
      this.transition({ phase: "running", task: taskDescription, iteration: 1, maxIterations: procedure.steps.length || 1 });
      const report = await executeProcedure(procedure, {
        llm: this.llm,
        workspaceRoot: this.workspaceRoot,
        onStepStart: (step) => this.io.action(step.action, { stepId: step.stepId, name: step.name, command: step.command }),
        onStepEnd: (_step, stepReport) => this.io.observation(stepReport.ok ? stepReport.output : (stepReport.error ?? "step failed"), !stepReport.ok),
      });

      this.iterationCount = report.stepReports.length;
      this.lastMessages = report.stepReports.map((s) => ({
        role: "tool",
        name: s.stepId,
        content: s.ok ? s.output : `ERROR: ${s.error ?? ""}`,
      }));

      if (report.status === "completed") {
        this.lastOutcome = "completed";
        this.transition({ phase: "completed", task: taskDescription, outcome: "completed" });
        return report.finalOutput || "Procedure completed with no output.";
      }

      this.lastOutcome = "partial_completion";
      this.transition({ phase: "completed", task: taskDescription, outcome: "partial_completion" });
      const failed = report.stepReports.filter((s) => !s.ok);
      return `Procedure ${report.status === "halted" ? "halted" : "failed"} after ${report.stepReports.length} step(s).\n${failed
        .map((s) => `- ${s.stepId}: ${s.error ?? "failed"}`)
        .join("\n")}\n\nPartial output:\n${report.finalOutput}`;
    } catch (err) {
      this.lastOutcome = "partial_completion";
      const message = err instanceof Error ? err.message : String(err);
      this.transition({
        phase: "error",
        task: taskDescription,
        error: { type: "llm", message, retryable: true },
      });
      return `Stopped: ${message}`;
    }
  }

  async generatePlan(taskDescription: string): Promise<string> {
    this.transition({ phase: "planning", task: taskDescription });
    this.io.spinnerStart("Drafting plan...");
    let plan: string;
    try {
      plan = await this.router.chat({
        messages: [
          {
            role: "user",
            content: `You are a system architect. Break down the following user task into a logical sequence of technical steps. Keep it strictly to the steps needed to accomplish the goal.\n\nTASK: ${taskDescription}\n\nRespond with a clear, numbered list of steps.`,
          },
        ],
        role: "orchestrator",
      });
    } finally {
      this.io.spinnerStop();
    }
    this.transition({ phase: "completed", task: taskDescription, outcome: "completed" });
    return plan.trim();
  }

  selectSkills(_taskDescription: string): LoadedSkill[] {
    return [];
  }

  getLastOutcome(): RunOutcome {
    return this.lastOutcome;
  }

  getCumulativeUsage(): LlmUsage | undefined {
    return { ...this.cumulativeUsage };
  }

  getHealthScore(): number {
    return this.healthScore;
  }

  getPartialSuccess(): PartialSuccessContext | undefined {
    return undefined;
  }

  getSubagentLimitContext(): SubagentLimitContext | undefined {
    return undefined;
  }

  // ─── IReactEngineV2 ────────────────────────────────────────────────────────────

  cancel(reason?: string): void {
    if (this.state.phase === "idle" || this.state.phase === "completed" || this.state.phase === "cancelled") {
      return; // idempotent
    }
    this.cancelled = true;
    const task = "task" in this.state ? this.state.task : "";
    this.transition({ phase: "cancelled", task, reason: reason ?? "cancelled by caller" });
  }

  onProgress(observer: ProgressObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  getState(): EngineState {
    return this.state;
  }

  getLastMessages(): LlmMessage[] {
    return this.lastMessages;
  }

  getWorkspacePath(): string {
    return this.workspaceRoot;
  }

  getIterationCount(): number {
    return this.iterationCount;
  }

  private transition(state: EngineState): void {
    this.state = state;
    for (const observer of this.observers) observer(state);
  }
}
