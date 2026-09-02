// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:53:40.018Z | ronin:subtask code-st-5a7e6a
import { LlmClient, LlmMessage, LlmUsage, TelemetryInterface, ToolSchema, LoadedSkill } from "../types.js";
import { TOOL_SCHEMAS } from "../../tools/toolSchemas.js";
import { dispatchToolCall } from "../../tools/toolDispatcher.js";
import { SkillRegistry } from "../skillRegistry.js";
import { buildProtocolPrompt } from "../protocol.js";
import { compactStaleFileReads } from "../contextCompaction.js";
import { checkForTruncatedToolCalls, truncationWarningFor } from "../truncationGuard.js";
import { createHealthState, scoreStep, rollingHealth, HealthState } from "../stepScorer.js";
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

// ─── Constants ────────────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `You are xcoder, a ReAct CLI agent. You have tools for searching the workspace
(glob_tool, grep_tool, read_tool, list_directory_tool, find_files_tool, search_code_tool, search_ast_tool, get_dependency_graph_tool), making changes (write_edit_tool, ssh_tool, github_tool,
docker_deploy_ssh_tool, schedule_task_tool), validating your work (run_command_tool,
playwright_run_tool), and delegating isolated sub-tasks (subagent_tool). Follow the ReAct
pattern: search for context before editing, and always validate your changes before
considering a task done. Stop calling tools once the task is verified complete, and
summarize what you did.`;

// ─── Options ──────────────────────────────────────────────────────────────────────

export interface SimpleReactEngineOptions {
  maxIterations?: number;
  cwd?: string;
  tools?: ToolSchema[];
  systemPrompt?: string;
  consoleThoughts?: boolean;
  io?: AgentIO;
  /** Set to true to keep every historical read_tool observation in full (disables the default
   *  lean-token context compaction). See src/core/contextCompaction.ts. Default: false (compact). */
  fullContextToken?: boolean;
}

// ─── Engine ───────────────────────────────────────────────────────────────────────

/**
 * SimpleReactEngine — the bare ReAct loop and nothing else.
 *
 * This is deliberately the simplest engine in src/core/engine/: Thought -> Action -> Observation,
 * repeat until the model stops calling tools or the iteration limit is hit. No Plan Mode (no
 * up-front plan generated/approved before execution), no Phase Planning (no dividing the task
 * into multiple phases run as sub-orchestrators), no goal-validation retry loop (whatever the
 * model says when it stops calling tools IS the final answer, not "a candidate to be checked by
 * a second LLM call"), and no self-healing nudges (no injected "your health score is low, try a
 * different approach" messages). Those all live in ReActOrchestrator (`react`) and, to a lesser
 * degree, LeanEngine (`lean`, which keeps goal validation + self-healing but already drops Plan
 * Mode/Phase Planning) — this engine is one level simpler than either.
 *
 * What IS kept, because these are correctness/cost fixes rather than "planning" behavior:
 * - Context compaction (contextCompaction.ts) — without it, every read/write of a file stays in
 *   history forever, which is how a real session blew past DeepSeek's context limit (see
 *   truncationGuard.ts's doc comment and the conversation notes from 2026-07-25).
 * - Truncation guard (truncationGuard.ts) — withholds a write_edit_tool call whose content was
 *   cut off by the completion token limit instead of silently writing a truncated file
 *   (PM-2026-07-25-001).
 * - Passive health scoring (stepScorer.ts) so getHealthScore() reports something real — but
 *   nothing is done with the score. No nudge messages get injected into the conversation.
 *
 * Console output matches ReActOrchestrator/LeanEngine exactly: the same spinner ("Thinking...")
 * while waiting on the LLM, the same thought/action/observation/usage calls in the same places,
 * so this engine is a drop-in swap for `--engine simple` with no difference in what you see
 * printed, only in what happens (or doesn't) between those prints.
 */
export class SimpleReactEngine implements IReactEngine, IReactEngineV2 {
  private llm: LlmClient;
  private telemetry: TelemetryInterface;
  private opts: SimpleReactEngineOptions;
  private registry = new SkillRegistry();
  private io: AgentIO;
  private cwd: string;

  // Lifecycle state
  private state: EngineState = { phase: "idle" };
  private observers: Set<ProgressObserver> = new Set();
  private cancelled = false;

  // Run tracking
  private cumulativeUsage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  private llmCallCount = 0;
  private iterationCount = 0;
  private lastOutcome: RunOutcome = "completed";
  private lastMessages: LlmMessage[] = [];
  private health: HealthState = createHealthState();

  constructor(llm: LlmClient, telemetry: TelemetryInterface, opts: SimpleReactEngineOptions = {}) {
    this.llm = llm;
    this.telemetry = telemetry;
    this.opts = opts;
    this.cwd = opts.cwd ?? process.cwd();
    this.io = opts.io ?? new AutoIO();
  }

  // ─── IReactEngineV2 implementation ──────────────────────────────────────────────

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
    return this.cwd;
  }

  getIterationCount(): number {
    return this.iterationCount;
  }

  // ─── IReactEngine implementation ────────────────────────────────────────────────

  getLastOutcome(): RunOutcome {
    return this.lastOutcome;
  }

  getCumulativeUsage(): LlmUsage {
    return { ...this.cumulativeUsage };
  }

  getHealthScore(window = 5): number {
    return rollingHealth(this.health, window);
  }

  /** SimpleReactEngine doesn't synthesize a partial-success report — it just returns whatever
   *  the model last said. Always undefined; kept for interface compatibility with callers that
   *  check this after an iteration_limit outcome regardless of which engine ran. */
  getPartialSuccess(): PartialSuccessContext | undefined {
    return undefined;
  }

  /** SimpleReactEngine doesn't delegate to subagents with their own limit-tracking — regular
   *  subagent_tool calls, if any, are dispatched like any other tool. Always undefined. */
  getSubagentLimitContext(): SubagentLimitContext | undefined {
    return undefined;
  }

  selectSkills(taskDescription: string): LoadedSkill[] {
    const headers = this.registry.route(taskDescription);
    const primary = headers[0];
    if (!primary) return [];

    const names = new Set<string>([primary.name, ...primary.composes_with]);
    return [...names]
      .map((n) => this.registry.loadSkill(n))
      .filter((s): s is LoadedSkill => Boolean(s));
  }

  /**
   * Generates a plan on request (e.g. for an API "preview plan" endpoint) without ever calling
   * this internally during run() — run() always goes straight to the ReAct loop. Kept for
   * IReactEngine interface compatibility so callers that always offer a "preview plan" action
   * don't need to special-case this engine.
   */
  async generatePlan(taskDescription: string): Promise<string> {
    const skills = this.selectSkills(taskDescription);
    const skillContext = skills.length
      ? `\n\nThe following specialized skills are relevant to this task — let their guidance shape the plan's steps:\n\n${skills
          .map((s) => `## ${s.header.name} (${s.header.role})\n${s.body}`)
          .join("\n\n")}`
      : "";

    const planPrompt: LlmMessage[] = [
      {
        role: "system",
        content:
          buildProtocolPrompt(this.cwd) +
          "You are in Plan Mode. Do not call any tools. Produce a short, concrete, checkable " +
          "plan for the task below as a markdown checklist (`- [ ] step`), 3-8 steps. " +
          "No prose outside the checklist." +
          skillContext,
      },
      { role: "user", content: taskDescription },
    ];

    const response = await this.llm.complete(planPrompt);
    this.addUsage(response.usage);
    return `# Plan: ${taskDescription}\n\n${response.content.trim()}\n`;
  }

  async run(taskDescription: string, _runOpts: RunOptions = {}): Promise<string> {
    this.cancelled = false;
    this.lastOutcome = "completed";
    this.iterationCount = 0;
    this.lastMessages = [];
    this.health = createHealthState();
    this.llmCallCount = 0;

    const showConsole = this.opts.consoleThoughts !== false;
    const maxIterations = this.opts.maxIterations ?? 20;

    const skills = this.selectSkills(taskDescription);
    if (showConsole) {
      if (skills.length === 0) {
        this.io.log("Walang natugmang skill para sa gawaing ito. Magpapatuloy gamit ang base ReAct loop lamang.");
      } else {
        this.io.log(`Mga na-load na skill: ${skills.map((s) => s.header.name).join(", ")}`);
      }
    }

    const messages: LlmMessage[] = [
      { role: "system", content: this.buildSystemPrompt(skills) },
      { role: "user", content: taskDescription },
    ];

    let finalContent = "";
    let iteration = 0;

    this.transition({ phase: "running", task: taskDescription, iteration, maxIterations });

    while (iteration < maxIterations && !this.cancelled) {
      iteration++;
      this.iterationCount = iteration;
      this.transition({ phase: "running", task: taskDescription, iteration, maxIterations });

      // ── LLM call ──
      if (showConsole) this.io.spinnerStart("Thinking...");
      let response;
      try {
        response = await this.llm.complete(messages, { tools: this.opts.tools ?? TOOL_SCHEMAS });
      } catch (err) {
        if (showConsole) this.io.spinnerStop();
        await this.telemetry.logError(err, `LLM call failed at iteration ${iteration}`);
        this.transition({
          phase: "error",
          task: taskDescription,
          error: { type: "llm", message: err instanceof Error ? err.message : String(err), retryable: true },
        });
        throw err;
      }
      if (showConsole) this.io.spinnerStop();
      this.addUsage(response.usage);

      // Show reasoning
      if (showConsole) {
        if (response.toolCalls.length > 0) {
          this.io.thought(response.reasoningContent ?? response.content);
        } else if (response.reasoningContent) {
          this.io.thought(response.reasoningContent);
        }
        this.io.usage(response.usage, this.cumulativeUsage.totalTokens);
      }

      // ── No tool calls → this IS the final answer, no validation retry loop ──
      if (response.toolCalls.length === 0) {
        finalContent = response.content;
        if (showConsole) this.io.log(response.content);
        this.lastMessages = messages;
        this.transition({ phase: "completed", task: taskDescription, outcome: "completed" });
        if (showConsole) this.printSummary();
        return finalContent;
      }

      // ── Tool calls ──
      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls,
        reasoning_content: response.reasoningContent,
      });

      const { safeCalls, blockedCalls } = checkForTruncatedToolCalls(response);
      for (const blocked of blockedCalls) {
        messages.push({ role: "tool", tool_call_id: blocked.id, name: blocked.function.name, content: truncationWarningFor(blocked) });
        if (showConsole) this.io.observation(`[withheld — response truncated by token limit] ${blocked.function.name}`, true);
      }

      for (const call of safeCalls) {
        if (showConsole) this.io.action(call.function.name, safeParse(call.function.arguments));

        const result = await dispatchToolCall(call, this.cwd);
        const { score } = scoreStep(this.health, {
          tool: result.toolName,
          args: safeParse(call.function.arguments),
          observation: result.observation,
          isError: result.isError,
        });
        if (showConsole) this.io.observation(result.observation, result.isError, undefined, score);

        messages.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          name: result.toolName,
          content: JSON.stringify(result.observation),
        });

        // Context compaction (lean-token mode, always on for this engine — there's no
        // fullContextToken-off equivalent here that would ever make sense to disable, but the
        // option is honored for consistency with the other engines).
        if (!this.opts.fullContextToken && (result.toolName === "read_tool" || result.toolName === "write_edit_tool")) {
          const args = call.function.arguments ? safeParseFilePath(call.function.arguments) : undefined;
          if (args?.filePath) {
            compactStaleFileReads(messages, args.filePath, result.toolCallId);
          }
        }
      }

      finalContent = response.content || finalContent;
    }

    // ── Iteration limit hit without a final answer — no partial-success synthesis, just say so ──
    this.lastOutcome = "iteration_limit";
    this.lastMessages = messages;
    this.transition({ phase: "completed", task: taskDescription, outcome: "iteration_limit" });
    if (showConsole) this.printSummary();

    return finalContent || `Reached the ${maxIterations}-iteration limit without a final answer.`;
  }

  // ─── Internals ──────────────────────────────────────────────────────────────────

  private buildSystemPrompt(skills: LoadedSkill[]): string {
    const skillContext = skills.length
      ? `\n\nThe following specialized skills are relevant to this task:\n\n${skills
          .map((s) => `## ${s.header.name} (${s.header.role})\n${s.body}`)
          .join("\n\n")}`
      : "";
    return buildProtocolPrompt(this.cwd) + (this.opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT) + skillContext;
  }

  private printSummary(): void {
    this.io.totalUsage(this.cumulativeUsage, this.llmCallCount);
    this.io.log(`📈 Final health score: ${this.getHealthScore()}/100 (${this.health.scores.length} scored steps)`);
  }

  private addUsage(usage?: LlmUsage): void {
    if (!usage) return;
    this.llmCallCount++;
    this.cumulativeUsage.promptTokens += usage.promptTokens;
    this.cumulativeUsage.completionTokens += usage.completionTokens;
    this.cumulativeUsage.totalTokens += usage.totalTokens;
    this.cumulativeUsage.reasoningTokens = (this.cumulativeUsage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
    this.cumulativeUsage.cachedTokens = (this.cumulativeUsage.cachedTokens ?? 0) + (usage.cachedTokens ?? 0);
  }

  private transition(state: EngineState): void {
    this.state = state;
    for (const observer of this.observers) observer(state);
  }
}

// ─── Standalone helper functions ──────────────────────────────────────────────────

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function safeParseFilePath(json: string): { filePath?: string } | undefined {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
