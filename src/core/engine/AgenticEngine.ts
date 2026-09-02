// ronin:version 8 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:47:05.513Z | ronin:subtask code-st-f034f3
// AgenticEngine — registered as "agentic". TS semantic port of
// the reference Python agentic_workflow (AgenticOrchestrator deterministic ReAct loop with an injectable
// ThinkFn), wrapped into the IReactEngine + IReactEngineV2 surface.
import { LlmClient, LlmMessage, LlmUsage, LoadedSkill, ToolCall } from "../types.js";
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
import { runAgenticLoop, continueAgenticLoop } from "../workflows/agenticLoop.js";
import { AgentDecision, AgentRunContext, AgentRunReport, ThinkFn, WorkflowToolContext } from "../workflows/types.js";
import { dispatchToolCall } from "../../tools/toolDispatcher.js";
import { TOOL_SCHEMAS } from "../../tools/toolSchemas.js";
import { SkillRegistry } from "../skillRegistry.js";

/** Engine-specific options: the design's AC-4 smoke-test seam injects a scripted ThinkFn. */
interface AgenticEngineOptions {
  thinkFn?: ThinkFn;
}

const THINK_SYSTEM_PROMPT = `You are the reasoning step of a ReAct coding agent. Given the task, the available tools, available skills, and the trace so far, decide the SINGLE next action.

Tool-specific notes:
- All tool paths (glob/grep/read/edit/run_command) are relative to the workspace_root in the user message below. Default any file you create there unless the task says otherwise.
- "skill" (Special Evolution): tool_input is JSON like {"op": "write", "name": "bug-fix-loop", "description": "...", "when_to_use": "...", "body": "..."}. Use "op": "write" to record a process/strategy you worked out mid-task as a reusable skill. Use "op": "list" or "op": "read" to check existing skills first.

Respond with ONLY a JSON object, no other text:
{
  "phase": "search" | "action" | "validation",
  "thought": "one or two sentences of reasoning",
  "tool": "<tool name, or \"none\" if the task is complete>",
  "tool_input": "<string input for the tool, following that tool's expected format>",
  "final_answer": "<only if tool is \"none\": the final answer/summary for the user>"
}`;

/**
 * AgenticEngine — deterministic agentic ReAct loop with an injectable ThinkFn.
 * The default ThinkFn drives the loop through the MultiRoleRouter's "orchestrator" role,
 * asking for a JSON AgentDecision each iteration. Tests inject a scripted ThinkFn directly.
 */
export class AgenticEngine implements IReactEngine, IReactEngineV2 {
  private llm: LlmClient; // usage-recording proxy over deps.llm
  private router: MultiRoleRouter;
  private workspaceRoot: string;
  private maxIterations: number;
  private think: ThinkFn;
  private skills = new SkillRegistry();
  private tools: WorkflowToolContext;
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
    this.maxIterations = deps.options?.maxIterations ?? 25;
    this.io = deps.io ?? new AutoIO();

    // Wrap the injected client so getCumulativeUsage() reflects every router/think/llm_call.
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

    this.router = new MultiRoleRouter(this.llm, {
      orchestrator: {},
      executor: {},
    });

    this.tools = {
      workspaceRoot: this.workspaceRoot,
      execTool: async (name, input) => {
        const args = toJsonArgs(name, input);
        const call: ToolCall = {
          id: `agentic_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: "function",
          function: { name, arguments: args },
        };
        this.io.action(name, input);
        const result = await dispatchToolCall(call, this.workspaceRoot);
        const text =
          typeof result.observation === "string"
            ? result.observation
            : JSON.stringify(result.observation ?? null);
        this.io.observation(result.observation, result.isError);
        return result.isError ? { ok: false, output: text, error: text } : { ok: true, output: text };
      },
    };

    const agenticOpts = deps.options as AgenticEngineOptions | undefined;
    this.think = agenticOpts?.thinkFn ?? this.defaultThink.bind(this);
  }

  // ─── IReactEngine ──────────────────────────────────────────────────────────────

  async run(taskDescription: string, _runOpts: RunOptions = {}): Promise<string> {
    this.cancelled = false;
    this.lastOutcome = "completed";
    this.iterationCount = 0;
    this.lastMessages = [];
    this.transition({ phase: "planning", task: taskDescription });
    this.transition({ phase: "running", task: taskDescription, iteration: 0, maxIterations: this.maxIterations });

    let report: AgentRunReport;
    try {
      report = await runAgenticLoop(taskDescription, this.maxIterations, this.think, this.tools);
    } catch (err) {
      this.lastOutcome = "partial_completion";
      const message = err instanceof Error ? err.message : String(err);
      this.transition({
        phase: "error",
        task: taskDescription,
        error: { type: "internal", message, retryable: false },
      });
      return `Stopped: ${message}`;
    }

    this.iterationCount = report.iterationsUsed;
    this.lastOutcome = mapStatus(report.status);
    this.transition({ phase: "completed", task: taskDescription, outcome: this.lastOutcome });
    return report.finalAnswer;
  }

  async continueRun(report: AgentRunReport, extraIterations?: number): Promise<AgentRunReport> {
    this.cancelled = false;
    this.transition({
      phase: "running",
      task: report.taskDescription,
      iteration: report.iterationsUsed,
      maxIterations: report.maxIterations,
    });
    const continued = await continueAgenticLoop(report, extraIterations ?? this.maxIterations, this.think, this.tools);
    this.iterationCount = continued.iterationsUsed;
    this.lastOutcome = mapStatus(continued.status);
    this.transition({ phase: "completed", task: continued.taskDescription, outcome: this.lastOutcome });
    return continued;
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
            content: `You are a system architect. Produce a concise, numbered execution plan for the task below. Keep it strictly to the steps needed to accomplish the goal.

TASK: ${taskDescription}`,
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

  // ─── Internals ─────────────────────────────────────────────────────────────────

  /** Default ThinkFn: ReAct prompt built from run context + skill bodies -> JSON AgentDecision. */
  private async defaultThink(ctx: AgentRunContext, _tools: WorkflowToolContext): Promise<AgentDecision> {
    const skillMenu = this.skills.list().map((h) => ({ name: h.name, description: h.description, triggers: h.triggers }));
    const traceSummary = ctx.trace.slice(-8).map((t) => ({
      iteration: t.iteration,
      phase: t.phase,
      thought: t.thought,
      tool: t.tool,
      tool_input: (t.tool_input ?? "").slice(0, 200),
      observation: (t.observation ?? "").slice(0, 500),
      ok: t.ok,
    }));

    const userPrompt = JSON.stringify({
      task_description: ctx.taskDescription,
      workspace_root: ctx.workspaceRoot,
      available_tools: TOOL_SCHEMAS.map((s) => s.function.name),
      available_skills: skillMenu,
      iterations_used: ctx.iterationsUsed,
      max_iterations: ctx.maxIterations,
      trace_so_far: traceSummary,
    });

    let raw: string;
    this.io.spinnerStart("Thinking...");
    try {
      raw = await this.router.chat({
        messages: [
          { role: "system", content: THINK_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        role: "orchestrator",
        responseFormat: "json_object",
      });
    } catch (err) {
      this.io.spinnerStop();
      return {
        phase: "search",
        thought: `(fallback: LLM decision failed: ${err instanceof Error ? err.message : String(err)})`,
        tool: "none",
        done: true,
        finalAnswer: `Stopped early: could not get a valid decision from the model (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    this.io.spinnerStop();

    let parsed: Record<string, unknown>;
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      return {
        phase: "search",
        thought: `(fallback: invalid JSON decision: ${err instanceof Error ? err.message : String(err)})`,
        tool: "none",
        done: true,
        finalAnswer: `Stopped early: the model returned invalid JSON (${err instanceof Error ? err.message : String(err)}).`,
      };
    }

    const tool = String(parsed.tool ?? "none") || "none";
    const thoughtText = String(parsed.thought ?? "");
    if (thoughtText) this.io.thought(thoughtText);
    return {
      phase: String(parsed.phase ?? "search"),
      thought: thoughtText,
      tool,
      tool_input: String(parsed.tool_input ?? ""),
      done: tool === "none",
      finalAnswer: String(parsed.final_answer ?? ""),
    };
  }

  private transition(state: EngineState): void {
    this.state = state;
    for (const observer of this.observers) observer(state);
  }
}

function mapStatus(status: string): RunOutcome {
  switch (status) {
    case "done":
      return "completed";
    default:
      return "partial_completion";
  }
}

/**
 * Map a raw string ThinkFn tool_input onto the JSON argument shape each tool expects.
 * run_command_tool/summarize_url_tool take a plain string wrapped in a named field;
 * anything else is passed through (objects are stringified, strings are kept raw).
 */
function toJsonArgs(name: string, input: unknown): string {
  if (typeof input !== "string") return JSON.stringify(input ?? {});
  if (name === "run_command_tool") return JSON.stringify({ command: input });
  if (name === "summarize_url_tool") return JSON.stringify({ url: input });
  if (name === "read_tool") return JSON.stringify({ filePath: input });
  if (name === "write_edit_tool") return JSON.stringify({ mode: "write", filePath: input });
  return input;
}
