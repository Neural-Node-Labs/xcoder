// ronin:version 3 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:47:29.172Z | ronin:subtask code-st-f034f3
// BrainEngine — registered as "brain". Exposes the shared MultiRoleRouter
// (port of the reference Python brain_workflow/router.py) through the IReactEngine + IReactEngineV2
// surface: runs a task across >=2 roles (orchestrator, critic) and synthesizes the
// final answer (AC-6).
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

/**
 * BrainEngine — the multi-role router as a callable engine.
 *
 * run(task) treats the task as a routing exercise across roles: the orchestrator role
 * produces an execution/answer draft, the critic role reviews it, and the final answer
 * synthesizes both (critic notes folded in). Built-in defaults are orchestrator + critic
 * over the injected LlmClient (AC-6: >=2 roles).
 */
export class BrainEngine implements IReactEngine, IReactEngineV2 {
  private llm: LlmClient; // usage-recording proxy over deps.llm
  private router: MultiRoleRouter;
  private workspaceRoot: string;
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
    // every role call the router makes.
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

    // >=2 roles (AC-6). Both default to the injected client's default model;
    // tests can seed per-role canned responses by inspecting the prompt/model,
    // or replace roles via getRouter().addRole().
    this.router = new MultiRoleRouter(this.llm, {
      orchestrator: {},
      critic: {},
    });
  }

  // ─── IReactEngine ──────────────────────────────────────────────────────────────

  async run(taskDescription: string, _runOpts: RunOptions = {}): Promise<string> {
    this.cancelled = false;
    this.lastOutcome = "completed";
    this.iterationCount = 0;
    this.lastMessages = [];
    this.transition({ phase: "planning", task: taskDescription });
    this.transition({ phase: "running", task: taskDescription, iteration: 0, maxIterations: 2 });

    try {
      this.io.spinnerStart("Orchestrator thinking...");
      let orchestratorAnswer: string;
      try {
        orchestratorAnswer = await this.router.chat({
          messages: [
            {
              role: "user",
              content: `You are the orchestrator role. Work through the following task and provide a complete, well-structured answer.\n\nTASK: ${taskDescription}`,
            },
          ],
          role: "orchestrator",
        });
      } finally {
        this.io.spinnerStop();
      }
      this.io.action("orchestrator_role", { task: taskDescription });
      this.io.observation(orchestratorAnswer, false);

      this.io.spinnerStart("Critic reviewing...");
      let criticNotes: string;
      try {
        criticNotes = await this.router.chat({
          messages: [
            {
              role: "user",
              content: `You are the critic role. Review the orchestrator's answer below strictly for correctness, gaps, and risks. Be concise.\n\nORCHESTRATOR ANSWER:\n${orchestratorAnswer}`,
            },
          ],
          role: "critic",
        });
      } finally {
        this.io.spinnerStop();
      }
      this.io.action("critic_role", { reviewing: "orchestrator_answer" });
      this.io.observation(criticNotes, false);

      this.iterationCount = 2;
      const finalAnswer = synthesize(orchestratorAnswer, criticNotes);
      this.lastMessages = [
        { role: "assistant", content: orchestratorAnswer },
        { role: "assistant", content: criticNotes },
        { role: "assistant", content: finalAnswer },
      ];
      this.transition({ phase: "completed", task: taskDescription, outcome: "completed" });
      return finalAnswer;
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
            content: `You are the orchestrator role. Produce a concise, numbered execution plan for the task below.\n\nTASK: ${taskDescription}`,
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

  // ─── Expose the router (brain stays the shared routing foundation) ────────────

  getRouter(): MultiRoleRouter {
    return this.router;
  }

  private transition(state: EngineState): void {
    this.state = state;
    for (const observer of this.observers) observer(state);
  }
}

/** Fold the critic's notes into the final answer, keeping the orchestrator's content first. */
function synthesize(orchestratorAnswer: string, criticNotes: string): string {
  const trimmed = criticNotes.trim();
  if (!trimmed) return orchestratorAnswer.trim();
  return `${orchestratorAnswer.trim()}\n\n---\nCritic review:\n${trimmed}`;
}
