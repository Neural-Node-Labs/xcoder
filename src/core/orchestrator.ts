// ronin:version 7 | ronin:task task-4508cb | ronin:updated 2026-08-13T15:54:51.628Z | ronin:subtask test-st-ec8121
import fs from "node:fs";
import path from "node:path";
import { LlmClient, LlmMessage, ReActStep, TelemetryInterface, LoadedSkill, Phase, LlmUsage, SubagentResult, ReActMemory, ScoreEntry, HealthScore, DEFAULT_HEALTH_SCORE } from "./types.js";
import { SkillRegistry } from "./skillRegistry.js";
import { TOOL_SCHEMAS } from "../tools/toolSchemas.js";
import { dispatchToolCall } from "../tools/toolDispatcher.js";
import { buildProtocolPrompt, writeTodo, appendTodoReview } from "./protocol.js";
import { validateGoal, buildObservationTranscript } from "./goalValidator.js";
import { compactStaleFileReads } from "./contextCompaction.js";
import { checkForTruncatedToolCalls, truncationWarningFor } from "./truncationGuard.js";
import { createHealthState, scoreStep, rollingHealth, HealthState } from "./stepScorer.js";
import { appendTaskHistory } from "./taskHistory.js";
import { TaskHistoryStore } from "../api/taskHistoryStore.js";
import { PhaseReportStore } from "../api/phaseReportStore.js";
import { WbsStore } from "../api/wbsStore.js";
import { prepareWorkspace } from "./workspaceManager.js";
import { resolveTasksDir } from "../config/paths.js";
import { AgentIO } from "./io/AgentIO.js";
import { AutoIO } from "./io/AutoIO.js";
import { IReactEngine } from "./engine/IReactEngine.js";
import { refreshWorkspaceInfo, readCachedWorkspaceInfo, summarizeWorkspaceInfo } from "../indexing/workspaceInfo.js";


export interface OrchestratorOptions {
  maxIterations?: number; // "iteration maxout" ceiling per round
  cwd?: string;
  planMode?: "auto" | "always" | "never"; // "auto": plan mode kicks in for multi-skill/complex tasks
  validateGoal?: boolean; // independent second-agent audit before accepting completion (default: true)
  maxValidatorRetries?: number; // how many times a rejected claim gets sent back before giving up (default: 2)
  /**
   * When false, the orchestrator skips all interactive stdin prompts (plan approval, iteration
   * limit continuation). Plan mode still generates the plan and writes todo.md, but auto-approves
   * it. Iteration limit auto-continues. Set this for API/CI contexts where no TTY is available.
   * Defaults to true (interactive prompts enabled).
   */
  interactive?: boolean;
  /**
   * When true, the orchestrator runs in fully autonomous mode — automatically answering "yes"
   * to ALL interactive prompts (plan approval, phase plan approval, iteration limit continuation,
   * subagent continuation). This is the "auto-pilot" mode: the LLM drives end-to-end without
   * any human intervention. Overrides `interactive` and `continueOnLimit`. Set this for CI/CD,
   * automated testing, or any scenario where zero human input is desired.
   * Defaults to false.
   */
  auto?: boolean;
  /**
   * When true, the orchestrator auto-continues past the iteration limit instead of stopping.
   * Used by the API when the UI sends continueOnLimit: true. Overrides onIterationLimitReached.
   */
  continueOnLimit?: boolean;
  /**
   * Called when the iteration ceiling is hit and more work is needed. Return true to reset the
   * counter and continue, false to stop. Defaults to an interactive stdin yes/no prompt. Inject
   * this for automated diagnostics/CI where no TTY is available, or to log/audit every restart
   * decision (see src/core/liveDiagnostics.ts diagnostic #2).
   */
  onIterationLimitReached?: (taskDescription: string, iterationsSoFar: number) => Promise<boolean>;
  /**
   * Live console reporting: a spinner while waiting on the LLM, plus Thought/Action/Observation
   * lines printed as each ReAct step happens (in addition to telemetry, which already records
   * everything — this is purely for a human watching the terminal). Default: true.
   */
  consoleThoughts?: boolean;
  /** Internal — nesting depth used to indent subagent console output. Do not set directly. */
  consoleIndent?: number;
  /**
   * When true (default), collapses stale/superseded read_tool Observations (earlier full-file
   * snapshots of a path that's since been re-read or edited) down to a short placeholder
   * instead of keeping every historical copy in context — see src/core/contextCompaction.ts
   * for exactly what is and isn't touched, and why. Set fullContextToken to true to keep the
   * full history (the old default behavior).
   */
  leanToken?: boolean;
  /**
   * When true, keeps every historical copy of read_tool file snapshots in context instead of
   * collapsing stale/superseded ones (the default lean-token behavior). Set this to opt out
   * of context compaction and preserve the full read history. Default: false.
   */
  fullContextToken?: boolean;
  /**
   * When true (default), scores each tool step heuristically (see stepScorer.ts) and, if the
   * rolling average drops low, injects a one-time nudge into context asking the model to
   * reconsider its approach instead of continuing down a stuck path. Purely heuristic — no
   * extra LLM calls, no added cost/latency.
   */
  selfHealing?: boolean;
  /**
   * When true, tool operations (read/write/run_command/glob/grep/etc.) run against an isolated
   * copy of the project at <cwd>/workspace-agent/ instead of the live project directory — see
   * workspaceManager.ts. Protocol, lessons, task history, and todo.md still read/write at the
   * original project root regardless, since those are meant to persist across resets rather
   * than live inside the disposable copy. Default: false.
   */
  isolatedWorkspace?: boolean;
  /** Internal — lets subagents inherit the real project root for protocol/history/todo even
   *  when their `cwd` points at an already-isolated workspace-agent copy. Do not set directly. */
  projectRoot?: string;
  /**
   * When true, disables phase-based planning and runs as a single ReAct loop instead.
   * Phase planning (default ON) divides the task into multiple phases, each running as a
   * sub-orchestrator with isolated ReAct memory. Results from completed phases are summarized
   * and passed to the next phase. This reduces per-phase token footprint at the cost of losing
   * cross-phase context continuity. See enhancement/planning.md.
   * Default: false (phase planning is ON).
   */
  singlePhase?: boolean;
  /**
   * How the engine reports progress and asks for approval. Defaults to AutoIO (headless-safe:
   * logs to console, never touches stdin). The CLI passes a CliIO instance (src/cli/CliIO.ts)
   * for real terminal prompts/spinners; the API server relies on the AutoIO default so it can
   * never hang waiting on a prompt nobody will answer. See src/core/io/AgentIO.ts.
   */
  io?: AgentIO;
  /**
   * Kung pinapayagan ang run na ito na sumulat sa TaskHistoryStore/PhaseReportStore/WbsStore
   * (database-backed lahat — PostgreSQL, tingnan ang src/db/). Default: false.
   *
   * Ang file-based na logging (FileTelemetry sa ilalim ng .agent/logs/, at ang mga markdown
   * file sa ilalim ng .agent/tasks/) ay laging nangyayari anuman ang flag na ito — iyon ang
   * persistence story ng CLI at ito ay walang kondisyon. Kinokontrol lamang ng flag na ito
   * ang *karagdagang*, database-backed na persistence layer na binabasa ng UI (task history,
   * phase reports, WBS). Tanging src/api/routes.ts lamang ang nagtatakda nito sa true; hindi
   * kailanman ginagawa ito ng CLI, kaya ang isang `xcoder --task "..."` na run ay hindi
   * kailanman nagbubukas ng koneksyon sa database.
   */
  persistToDb?: boolean;
}

export interface RunOptions {
  skipPlanMode?: boolean; // true for subagent runs — subagents don't re-enter plan mode
  isSubagent?: boolean;
  /**
   * True only for genuine subagent_tool spawns: their parent consults
   * onIterationLimitReached, so the subagent itself stops at the limit without
   * invoking the callback. Phase-planning children must NOT set this — they
   * are the actual server of the caller's run and must honor the callback.
   */
  suppressOnIterationLimitReached?: boolean;
}

const READ_ONLY_TOOLS = new Set(["glob_tool", "grep_tool", "read_tool", "list_directory_tool", "find_files_tool", "get_dependency_graph_tool", "search_code_tool", "search_ast_tool", "read_outline_tool", "read_file_range_tool", "read_multiple_files_tool", "read_full_file_tool", "git_diff_tool", "git_log_tool", "validate_file_tool"]);
const ACTION_TOOLS = new Set(["write_edit_tool", "ssh_tool", "schedule_task_tool", "docker_deploy_ssh_tool"]);
const VALIDATION_TOOLS = new Set(["playwright_run_tool"]);
const GITHUB_READ_ACTIONS = new Set(["clone", "fetch", "pull", "status"]);
const VALIDATION_COMMANDS = /\b(test|lint|type-?check|tsc|jest|pytest|kubectl (apply|rollout)|docker build|docker compose|playwright)\b/i;

/**
 * Drives the full ReAct loop with real tool execution, under the xcoder.md engineering
 * protocol (Plan Mode, Subagent Strategy, Verification Before Done, etc — see agent/xcoder.md):
 *
 *   Plan Mode (if triggered) -> write tasks/todo.md -> confirm with user before proceeding
 *   Search phase      -> Thought -> Action(glob/grep/read) -> Observation
 *   Action phase      -> Thought -> Action(write/edit/ssh/deploy/...) -> Observation
 *   Validation phase  -> Thought -> Action(run_command/playwright_run) -> Observation -> decide
 *
 * subagent_tool is intercepted before generic dispatch: it spins a fresh ReActOrchestrator.run()
 * with skipPlanMode=true and returns only the final text summary — the sub-agent's own tool
 * calls and reasoning never enter the parent's message history, keeping context clean per the
 * "Subagent Strategy" directive.
 */
export class ReActOrchestrator implements IReactEngine {
  private registry = new SkillRegistry();
  private io: AgentIO;
  private cwd: string; // tool-execution root; becomes workspace-agent/ when isolatedWorkspace is on
  private projectRoot: string; // protocol/lessons/history/todo always live here, never inside workspace-agent

  /** Running total for this orchestrator instance, including every LLM call it made directly
   *  (main loop, goal validation, plan generation) plus everything its subagents used — see
   *  runSubagent(), which folds each subagent's total into its parent's before returning. */
  private cumulativeUsage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  private llmCallCount = 0;
  /** Total ReAct loop iterations across all restarts for this run (not just the current round).
   *  Reset to 0 at the start of each run() call. Each iteration is one LLM call + tool execution
   *  cycle. This is the "iteration count" reported in task history and phase reports. */
  private iterationCount = 0;
  private health: HealthState = createHealthState();
  /** ReAct memory with health score tracking (0.0-1.0 scale, with history and trend). */
  private memory: ReActMemory = { healthScore: { ...DEFAULT_HEALTH_SCORE } };
  private lastNudgeIteration = -Infinity;
  private lastOutcome: "completed" | "iteration_limit" | "plan_rejected" | "partial_success" | "partial_completion" = "completed";
  /** The last ReAct message history from the most recent run() call. Used by runSubagent()
   *  to extract accumulated context (tool calls, observations, last thought) when a subagent
   *  hits the iteration limit. */
  private lastMessages: LlmMessage[] = [];

  /**
   * Captures what was accomplished before the iteration limit was hit. Populated when the
   * orchestrator hits the iteration limit and synthesizes a partial-completion report.
   * Contains the last N tool calls, their results, and any files modified, so callers
   * (e.g. the API) can surface this information to the user.
   */
  private partialSuccess?: {
    /** The last N tool calls made before the iteration limit was hit. */
    toolCalls: { name: string; args: string; result: string }[];
    /** Files that were modified during the run (write_edit_tool calls). */
    filesModified: string[];
    /** Files that were read during the run (read_tool calls). */
    filesRead: string[];
    /** Commands that were executed (run_command_tool calls). */
    commandsRun: string[];
    /** The last assistant thought before hitting the limit. */
    lastThought: string;
    /** How many iterations were completed before hitting the limit. */
    iterationCount: number;
    /** How many restarts occurred. */
    restartCount: number;
  };

  /** Read-only view of the partial success context, if any. Used by the API to include
   *  partial-progress information in limitation responses so the UI can show what was
   *  accomplished before the iteration limit was hit. */
  getPartialSuccess(): typeof this.partialSuccess {
    return this.partialSuccess;
  }

  /** How the most recent run() call ended. "completed" means a genuine final answer was
   *  reached; "partial_success" means the iteration limit was hit but meaningful progress
   *  was made and a summary was produced; "partial_completion" means the iteration limit
   *  was hit and a detailed partial-success record was captured with tool calls, results,
   *  and files modified; anything else means the returned text is a fallback explanation,
   *  not a real result, and callers (e.g. the API) should surface that distinction rather
   *  than treating it as a normal success. */
  getLastOutcome(): "completed" | "iteration_limit" | "plan_rejected" | "partial_success" | "partial_completion" {
    return this.lastOutcome;
  }

  /**
   * When a subagent hit the iteration limit and the user declined to continue (or the API
   * returned false from onIterationLimitReached), this contains the subagent's preserved
   * context so the API can pass it back to the UI for a "Continue" button that preserves
   * the subagent's progress. Undefined when no subagent limit was encountered.
   */
  private subagentLimitContext?: {
    lastThought: string;
    toolCalls: string[];
    observations: string[];
    iterationCount: number;
  };

  /** Read-only view of the subagent limit context, if any. Used by the API to include
   *  preserved subagent context in limitation responses so the UI can re-send it. */
  getSubagentLimitContext(): { lastThought: string; toolCalls: string[]; observations: string[]; iterationCount: number } | undefined {
    return this.subagentLimitContext;
  }

  /** Read-only view of this run's rolling self-healing health score (0-100, 100 = no signal yet). */
  getHealthScore(window = 5): number {
    return rollingHealth(this.health, window);
  }

  /**
   * Read-only view of the ReAct memory health score (0.0-1.0 scale with history and trend).
   * Returns the current HealthScore object including current value, history, and trend.
   */
  getMemoryHealthScore(): HealthScore {
    return { ...this.memory.healthScore };
  }

  /**
   * Updates the ReAct memory health score after each tool call and observation.
   *
   * Two strategies, tried in order:
   * 1. **LLM self-assessment** — parses the LLM's reasoning for a `score: X` token
   *    (e.g., `score: 0.7`) on a 0.0-1.0 scale. If found and valid, uses that value.
   * 2. **Heuristic fallback** — if the last tool call succeeded and produced a non-empty
   *    observation, increment by 0.1 (capped at 1.0); if it failed or errored, decrement
   *    by 0.2 (floored at 0.0).
   *
   * Appends a ScoreEntry to memory.healthScore.history and recalculates the trend
   * based on the last 3 entries.
   */
  private updateHealthScore(
    thought: string,
    toolName: string,
    observation: unknown,
    isError: boolean
  ): void {
    let newScore: number;
    let reason: string;

    // Strategy 1: Try to parse a self-assessed score from the LLM's reasoning
    const parsedScore = this.parseSelfAssessedScore(thought);
    if (parsedScore !== null) {
      newScore = parsedScore;
      reason = `self-assessed score: ${parsedScore.toFixed(2)}`;
    } else {
      // Strategy 2: Heuristic fallback based on tool call success/failure
      const obsStr = typeof observation === "string" ? observation : JSON.stringify(observation);
      if (isError) {
        newScore = Math.max(0, this.memory.healthScore.current - 0.2);
        reason = `tool call errored: ${toolName}`;
      } else if (obsStr && obsStr.length > 0 && obsStr !== "null" && obsStr !== "undefined") {
        newScore = Math.min(1.0, this.memory.healthScore.current + 0.1);
        reason = `tool call succeeded: ${toolName}`;
      } else {
        // Tool succeeded but returned empty — mild penalty (no progress)
        newScore = Math.max(0, this.memory.healthScore.current - 0.05);
        reason = `tool call returned empty: ${toolName}`;
      }
    }

    // Update current score
    this.memory.healthScore.current = newScore;

    // Append ScoreEntry to history
    const entry: ScoreEntry = {
      timestamp: new Date().toISOString(),
      score: newScore,
      reason,
    };
    this.memory.healthScore.history.push(entry);

    // Recalculate trend based on last 3 entries
    this.memory.healthScore.trend = this.calculateTrend(
      this.memory.healthScore.history.slice(-3)
    );
  }

  /**
   * Parses the LLM's reasoning for a self-assessed score token.
   * Looks for patterns like `score: 0.7` or `score:0.7` on a 0.0-1.0 scale.
   * Returns the parsed number (0.0-1.0) or null if not found/invalid.
   */
  private parseSelfAssessedScore(thought: string): number | null {
    if (!thought) return null;

    // Match patterns: "score: 0.7", "score:0.7", "score: .7", "score: 1"
    const match = thought.match(/score\s*:\s*(\d+(?:\.\d+)?|\.\d+)/i);
    if (!match) return null;

    const value = parseFloat(match[1]);
    if (isNaN(value) || value < 0 || value > 1) return null;

    return value;
  }

  /**
   * Calculates the trend direction based on the last N score entries.
   * - 'up' if the most recent score is higher than the earliest
   * - 'down' if the most recent score is lower than the earliest
   * - 'stable' if they're equal or there's only 1 entry
   */
  private calculateTrend(entries: ScoreEntry[]): "up" | "down" | "stable" {
    if (entries.length < 2) return "stable";

    const first = entries[0].score;
    const last = entries[entries.length - 1].score;

    if (last > first) return "up";
    if (last < first) return "down";
    return "stable";
  }

  constructor(
    private llm: LlmClient,
    private telemetry: TelemetryInterface,
    private opts: OrchestratorOptions = {}
  ) {
    this.cwd = opts.cwd ?? process.cwd();
    this.projectRoot = opts.projectRoot ?? this.cwd;
 //   this.projectAgentRoot = path.join(this.projectRoot, ".agent");
    this.io = opts.io ?? new AutoIO();
  }

  /** The effective tool-execution root for this run — the isolated workspace-agent copy when
   *  isolatedWorkspace is on, otherwise the project root itself. Useful for callers (e.g. the
   *  API's download endpoint) that need to know where the agent actually wrote its output. */
  getWorkspacePath(): string {
    return this.cwd;
  }

  /** Read-only view of this run's cumulative token usage (includes subagent usage). */
  getCumulativeUsage(): LlmUsage {
    return { ...this.cumulativeUsage };
  }

  /** Read-only view of this run's total ReAct loop iterations (includes subagent iterations). */
  getIterationCount(): number {
    return this.iterationCount;
  }

  /** Read-only view of the last ReAct message history from the most recent run() call.
   *  Used by runSubagent() to extract accumulated context (tool calls, observations,
   *  last thought) when a subagent hits the iteration limit. */
  getLastMessages(): LlmMessage[] {
    return this.lastMessages;
  }

  private addUsage(usage: LlmUsage | undefined): void {
    if (!usage) return;
    this.llmCallCount += 1;
    this.cumulativeUsage.promptTokens += usage.promptTokens;
    this.cumulativeUsage.completionTokens += usage.completionTokens;
    this.cumulativeUsage.totalTokens += usage.totalTokens;
    this.cumulativeUsage.reasoningTokens = (this.cumulativeUsage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
    this.cumulativeUsage.cachedTokens = (this.cumulativeUsage.cachedTokens ?? 0) + (usage.cachedTokens ?? 0);
  }

  /** Folds a subagent's own cumulative usage (and call count) into this instance's total. */
  private absorbSubagentUsage(sub: ReActOrchestrator): void {
    const subUsage = sub.getCumulativeUsage();
    this.cumulativeUsage.promptTokens += subUsage.promptTokens;
    this.cumulativeUsage.completionTokens += subUsage.completionTokens;
    this.cumulativeUsage.totalTokens += subUsage.totalTokens;
    this.cumulativeUsage.reasoningTokens = (this.cumulativeUsage.reasoningTokens ?? 0) + (subUsage.reasoningTokens ?? 0);
    this.cumulativeUsage.cachedTokens = (this.cumulativeUsage.cachedTokens ?? 0) + (subUsage.cachedTokens ?? 0);
    this.llmCallCount += sub.llmCallCount;
    this.iterationCount += sub.getIterationCount();
  }

  /** Route the task to one or more skills (multi-skill composition via composes_with). */
  selectSkills(taskDescription: string): LoadedSkill[] {
    const headers = this.registry.route(taskDescription);
    const primary = headers[0];
    if (!primary) return [];

    const names = new Set<string>([primary.name, ...primary.composes_with]);
    return [...names]
      .map((n) => this.registry.loadSkill(n))
      .filter((s): s is LoadedSkill => Boolean(s));
  }

  async run(taskDescription: string, runOpts: RunOptions = {}): Promise<string> {
    this.lastOutcome = "completed";
    if (this.opts.isolatedWorkspace && !runOpts.isSubagent) {
      this.cwd = prepareWorkspace(this.projectRoot);
    }

    const skills = this.selectSkills(taskDescription);
    const maxIterations = this.opts.maxIterations ?? 50;

    const indent = this.opts.consoleIndent ?? 0;
    const headerPrefix = indent > 0 ? "  ".repeat(indent) : "";
    this.io.log(`${headerPrefix}\n--- Pinapatakbo ang gawain: "${taskDescription}" ---\n${headerPrefix} (maxIterations=${maxIterations}, planMode=${this.opts.planMode ?? "auto"}, validateGoal=${this.opts.validateGoal ?? true})\n`);
    if (this.opts.isolatedWorkspace && !runOpts.isSubagent) {
      this.io.log(`${headerPrefix}Tumatakbo sa isolated na workspace: ${this.cwd}\n`);
    }

    if (!runOpts.isSubagent) {
      // Refresh the workspace snapshot (file tree, tech stack, git status, package manifest)
      // before any LLM call — this is what buildSystemPrompt() below picks up via the cache, and
      // what every sub-orchestrator (phases, subagents) reads without re-scanning. The LLM can
      // still explicitly re-trigger a rebuild mid-task via workspace_info_tool(refresh=true).
      try {
        await refreshWorkspaceInfo(this.cwd);
      } catch (err) {
        this.io.warn(`[workspaceInfo] Nabigong i-refresh ang workspace snapshot: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (skills.length === 0) {
        this.io.log("Walang natugmang skill para sa gawaing ito. Magpapatuloy gamit ang base ReAct loop lamang.");
      } else {
        this.io.log(`Mga na-load na skill: ${skills.map((s) => s.header.name).join(", ")}`);
      }
    }

    // --- Plan Mode ---
    // "Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)."
    // Heuristic for "non-trivial": multiple skills routed (implies cross-cutting work).
    const shouldPlan =
      !runOpts.skipPlanMode &&
      (this.opts.planMode === "always" || (this.opts.planMode !== "never" && skills.length >= 2));

    if (shouldPlan) {
      const proceed = await this.runPlanMode(taskDescription, skills);
      if (!proceed) {
        this.io.log("Tinanggihan ang plano. Ihihinto.");
        this.lastOutcome = "plan_rejected";
        return "(No changes were made — the generated plan was not approved before execution.)";
      }
    }

    // --- Phase Planning ---
    // When phasePlanning is enabled, the task is divided into multiple phases, each running as
    // a sub-orchestrator with isolated ReAct memory. Results from completed phases are summarized
    // and passed to the next phase. This reduces per-phase token footprint at the cost of losing
    // cross-phase context continuity. See enhancement/planning.md.
    if (!this.opts.singlePhase && !runOpts.isSubagent) {
      return await this.runPhasePlanning(taskDescription, skills, runOpts);
    }

    const messages: LlmMessage[] = [
      { role: "system", content: buildSystemPrompt(skills, this.projectRoot) },
      { role: "user", content: taskDescription },
    ];

    let iteration = 0;
    let finalContent = "";
    let validatorRejections = 0;
    let restartCount = 0;
    const maxValidatorRetries = this.opts.maxValidatorRetries ?? 2;
    const validationEnabled = this.opts.validateGoal !== false; // default true
    const showConsole = this.opts.consoleThoughts !== false; // default true

    while (true) {
      iteration += 1;
      this.iterationCount += 1;

      if (iteration > maxIterations) {
        if (runOpts.suppressOnIterationLimitReached) {
          // Genuine subagent_tool spawns don't interactively prompt — they just stop and
          // report what they have; their parent consults onIterationLimitReached.
          // Instead of a hardcoded string, synthesize a meaningful report from the message
          // history so the parent orchestrator gets useful partial-progress information.
          this.lastOutcome = "partial_success";
          finalContent = await this.synthesizeReport(
            taskDescription,
            messages,
            finalContent,
            maxIterations,
            restartCount
          );
          break;
        }
        // auto mode takes highest priority — auto-continue without asking
        const shouldContinue = this.opts.auto
          ? true
          : this.opts.continueOnLimit
          ? true
          : this.opts.onIterationLimitReached
          ? await this.opts.onIterationLimitReached(taskDescription, iteration - 1)
          : await this.askContinue(taskDescription, maxIterations);
        await this.telemetry.logThought({
          iteration,
          phase: "validation",
          thought: `iteration limit reached (${maxIterations}); restart ${shouldContinue ? "approved" : "declined"}`,
          action: { tool: "iteration_limit_check", input: { maxIterations, priorRestarts: restartCount } },
          observation: { approved: shouldContinue },
        });
        if (!shouldContinue) {
          this.io.log("Hinihinto sa kahilingan ng user.");
          this.lastOutcome = "partial_success";
          // Capture partial-success context before synthesizing the report.
          // This extracts the last N tool calls, files modified, files read,
          // commands run, and the last thought from the message history.
          // Callers (e.g. the API) can retrieve this via getPartialSuccess()
          // and include it in the response alongside the limitation field.
          this.extractPartialSuccessContext(messages, this.iterationCount, restartCount);
          // Always synthesize a proper report from the message history instead of
          // relying on finalContent (which may be empty or just a brief thought from
          // a tool-calling turn). This ensures the orchestrator NEVER returns an
          // empty or meaningless string — the user always gets a useful summary.
          finalContent = await this.synthesizeReport(
            taskDescription,
            messages,
            finalContent,
            maxIterations,
            restartCount
          );
          break;
        }
        restartCount += 1;
        iteration = 1; // reset iteration count for another round
      }

      if (showConsole) this.io.spinnerStart(indent > 0 ? "Subagent thinking..." : "Thinking...");
      const response = await this.llm.complete(messages, { tools: TOOL_SCHEMAS });
      if (showConsole) this.io.spinnerStop();
      this.addUsage(response.usage);

      // Show the model's reasoning as soon as it's available. When there ARE tool calls this is
      // genuinely a mid-task thought (falls back to `content` if the model isn't in thinking mode
      // and didn't return reasoning_content separately). When there are none, `content` IS the
      // final answer and gets printed via its own path below — only show reasoningContent here
      // to avoid printing the same text twice.
      if (showConsole) {
        if (response.toolCalls.length > 0) {
          this.io.thought(response.reasoningContent ?? response.content, indent);
        } else if (response.reasoningContent) {
          this.io.thought(response.reasoningContent, indent);
        }
        this.io.usage(response.usage, this.cumulativeUsage.totalTokens, indent);
      }

      if (response.toolCalls.length === 0) {
        // Candidate completion. Before accepting it, run it past an independent validator
        // (xcoder.md "Verification Before Done") unless validation is disabled or exhausted.
        if (validationEnabled && validatorRejections < maxValidatorRetries) {
          const transcript = buildObservationTranscript(messages);
          if (showConsole && !runOpts.isSubagent) this.io.spinnerStart("Validating completion...");
          const verdict = await validateGoal(this.llm, taskDescription, transcript, response.content);
          if (showConsole && !runOpts.isSubagent) this.io.spinnerStop();
          this.addUsage(verdict.usage);
          if (showConsole && !runOpts.isSubagent) this.io.usage(verdict.usage, this.cumulativeUsage.totalTokens, indent);

          // this.io.log(`iteration: ${iteration} thought: ${response.content} \naction: ${transcript} \nobservation:${verdict}` );
          await this.telemetry.logThought({
            iteration,
            phase: "validation",
            thought: deriveThought(response),
            action: { tool: "goal_validator", input: { transcript } },
            observation: verdict,
          });

          if (!verdict.valid) {
            validatorRejections += 1;
            if (!runOpts.isSubagent) {
              this.io.log(`\n[goal validator] Tinanggihan (pagsubok ${validatorRejections}/${maxValidatorRetries}): ${verdict.reason}`);
            }
            // Feed the rejection back in as new context and let the agent try again.
            messages.push({ role: "assistant", content: response.content, tool_calls: response.toolCalls, reasoning_content: response.reasoningContent });
            messages.push({
              role: "user",
              content: `VALIDATION FAILED: An independent reviewer found your claimed completion is not supported by the recorded observations. Reason: "${verdict.reason}". Address this — either take the actions needed to actually satisfy the task, or correct your claim to match what the observations actually show. Then report completion again.`,
            });
            continue; // loop back into the ReAct cycle, does NOT count against maxIterations differently — still increments iteration
          }
        }

        await this.telemetry.logThought({ iteration, phase: "validation", thought: deriveThought(response) });
        if (validationEnabled && validatorRejections >= maxValidatorRetries) {
          await this.telemetry.logError(
            { reason: "validator retries exhausted, accepting claim unverified" },
            "goal_validator"
          );
          if (!runOpts.isSubagent) {
            this.io.log(`\n[goal validator] Naubos na ang mga pagsubok (${validatorRejections}/${maxValidatorRetries}) — tinatanggap ang huling sagot nang WALANG independiyenteng verification.`);
          }
        }
        if (!runOpts.isSubagent) this.io.log(response.content);
        finalContent = response.content;
        break;
      }

      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls,
        reasoning_content: response.reasoningContent,
      });

      const { safeCalls, blockedCalls } = checkForTruncatedToolCalls(response);
      for (const blocked of blockedCalls) {
        messages.push({ role: "tool", tool_call_id: blocked.id, name: blocked.function.name, content: truncationWarningFor(blocked) });
        if (showConsole) this.io.observation(`[withheld — response truncated by token limit] ${blocked.function.name}`, true, indent);
      }

      for (const call of safeCalls) {
        if (call.function.name === "subagent_tool") {
          const parsedArgs = safeParse(call.function.arguments);
          const subTaskLabel =
            parsedArgs && typeof parsedArgs === "object" && "task" in (parsedArgs as Record<string, unknown>)
              ? String((parsedArgs as Record<string, unknown>).task)
              : call.function.arguments;
          if (showConsole) this.io.subagentStart(subTaskLabel, indent);

          const observation = await this.runSubagent(call.function.arguments);
          if (showConsole) this.io.observation(observation, false, indent);
          await this.telemetry.logThought({
            iteration,
            phase: "search",
            thought: deriveThought(response),
            action: { tool: "subagent_tool", input: safeParse(call.function.arguments) },
            observation,
          });

          // If the subagent hit the iteration limit, ask the user whether to continue.
          // When "yes", reset the subagent's iteration counter and re-invoke it with
          // the preserved context (partialOutput). When "no", synthesize a partial
          // completion report from the subagent's accumulated work.
          if (observation.status === "iteration_limit") {
            // auto mode takes highest priority — auto-continue without asking
            const shouldContinue = this.opts.auto
              ? true
              : this.opts.continueOnLimit
              ? true
              : this.opts.onIterationLimitReached
              ? await this.opts.onIterationLimitReached(taskDescription, this.iterationCount)
              : await this.askContinueSubagent(
                  taskDescription,
                  observation.iterationCount,
                  observation.partialOutput?.lastThought ?? "",
                  observation.partialOutput?.toolCalls ?? [],
                  observation.partialOutput?.observations ?? []
                );

            if (shouldContinue) {
              // Re-invoke the subagent with preserved context. We pass the subagent's
              // accumulated context (last thought, tool calls, observations) as additional
              // context so the new subagent run can pick up where the previous one left off.
              const continuationTask = `${JSON.parse(call.function.arguments).task}\n\n[CONTINUATION — previous subagent run hit the iteration limit after ${observation.iterationCount} iterations. The following context was preserved from the previous run:]\n\nLast thought:\n${observation.partialOutput?.lastThought ?? "(none)"}\n\nTool calls made:\n${(observation.partialOutput?.toolCalls ?? []).map((tc) => `- ${tc}`).join("\n")}\n\nKey observations:\n${(observation.partialOutput?.observations ?? []).map((o) => `- ${o}`).join("\n")}\n\nContinue from where you left off. Do not repeat work that was already completed.`;
              const continuationArgs = JSON.stringify({ task: continuationTask });
              const continuationResult = await this.runSubagent(continuationArgs);
              if (showConsole) this.io.observation(continuationResult, false, indent);
              // Use the continuation result as the final observation for this subagent call
              messages.push({ role: "tool", tool_call_id: call.id, name: "subagent_tool", content: JSON.stringify(continuationResult) });
              continue;
            } else {
              // User declined to continue — synthesize a partial completion report
              // from the subagent's accumulated work and use that as the observation.
              // Also store the subagent's preserved context so the API can pass it
              // back to the UI for a "Continue" button that preserves the subagent's
              // progress (see getSubagentLimitContext()).
              this.subagentLimitContext = {
                lastThought: observation.partialOutput?.lastThought ?? "",
                toolCalls: observation.partialOutput?.toolCalls ?? [],
                observations: observation.partialOutput?.observations ?? [],
                iterationCount: observation.iterationCount,
              };
              this.lastOutcome = "partial_success";
              const partialReport = await this.synthesizeSubagentPartialReport(
                taskDescription,
                observation.iterationCount,
                observation.partialOutput?.lastThought ?? "",
                observation.partialOutput?.toolCalls ?? [],
                observation.partialOutput?.observations ?? [],
                messages // pass full conversation history for richer context
              );
              messages.push({ role: "tool", tool_call_id: call.id, name: "subagent_tool", content: JSON.stringify({ status: "partial_success", summary: partialReport, iterationCount: observation.iterationCount }) });
              continue;
            }
          }

          messages.push({ role: "tool", tool_call_id: call.id, name: "subagent_tool", content: JSON.stringify(observation) });
          continue;
        }

        const phase = classifyPhase(call.function.name, call.function.arguments);
        const step: ReActStep = {
          iteration,
          phase,
          thought: deriveThought(response),
          action: { tool: call.function.name, input: safeParse(call.function.arguments) },
        };

        if (showConsole) this.io.action(step.action!.tool, step.action!.input, indent);
        const result = await dispatchToolCall(call, this.cwd);
        step.observation = result.observation;

        const selfHealingOn = this.opts.selfHealing !== false;
        if (selfHealingOn) {
          const { score } = scoreStep(this.health, {
            tool: result.toolName,
            args: step.action!.input,
            observation: result.observation,
            isError: result.isError,
          });
          step.score = score;
        }

        if (showConsole) this.io.observation(result.observation, result.isError, indent, step.score);
        await this.telemetry.logThought(step);

        if (result.isError) {
          await this.telemetry.logError(result.observation, `tool:${result.toolName}`);
        }

        messages.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          name: result.toolName,
          content: JSON.stringify(result.observation),
        });

        // Context compaction (lean-token mode, default ON): a fresh read_tool or write_edit_tool
        // observation for a path makes any earlier read_tool observation of that same path stale
        // — collapse it. Set fullContextToken to true to keep the full history instead.
        // See contextCompaction.ts for exactly what this does.
        if (!this.opts.fullContextToken && (result.toolName === "read_tool" || result.toolName === "write_edit_tool")) {
          const args = step.action?.input as { filePath?: string } | undefined;
          if (args?.filePath) {
            compactStaleFileReads(messages, args.filePath, result.toolCallId);
          }
        }
      }
      // Loop continues: the new Observations go back in as context for the next Thought.

      if (this.opts.selfHealing !== false) {
        const avgHealth = rollingHealth(this.health);
        const cooldownPassed = iteration - this.lastNudgeIteration >= 3;
        if (avgHealth < 40 && cooldownPassed && this.health.scores.length >= 2) {
          this.lastNudgeIteration = iteration;
          if (showConsole) this.io.healthWarning(avgHealth, indent);
          messages.push({
            role: "user",
            content: `[self-check] Your last several steps haven't been making much progress (rolling health score: ${avgHealth}/100 — errors and/or repeated identical actions with no new information). Before continuing: re-read the current state of whatever you're working on rather than assuming, double-check your last assumption was actually correct, and consider a genuinely different approach instead of retrying something similar.`,
          });
        }
      }
    }

    if (shouldPlan && !runOpts.isSubagent) {
      appendTodoReview(this.projectRoot, finalContent);
    }
    if (!runOpts.isSubagent) {
      const historyEntry = {
        task: taskDescription,
        summary: finalContent,
        iterations: this.iterationCount,
        totalTokens: this.cumulativeUsage.totalTokens || undefined,
      };
      appendTaskHistory(this.projectRoot, historyEntry);
      // Also persist to the database (best-effort) — API-only; see persistToDb doc comment.
      if (this.opts.persistToDb) {
        const taskHistoryStore = new TaskHistoryStore();
        await taskHistoryStore.save({
          task: historyEntry.task,
          summary: historyEntry.summary,
          iterations: historyEntry.iterations,
          totalTokens: historyEntry.totalTokens ?? null,
        });
        await taskHistoryStore.close();
      }
    }
    if (showConsole && !runOpts.isSubagent) {
      this.io.totalUsage(this.cumulativeUsage, this.llmCallCount, indent);
      if (this.health.scores.length > 0) {
        this.io.log(`${"  ".repeat(indent)}📈 Huling health score: ${this.getHealthScore()}/100 (${this.health.scores.length} na naka-score na hakbang)`);
      }
    }
    return finalContent;
  }

  /**
   * Extracts partial-success context from the message history when the iteration limit is hit.
   * Captures the last N tool calls, their results, files modified, files read, commands run,
   * and the last assistant thought. This context is stored in `this.partialSuccess` and can be
   * retrieved by callers (e.g. the API) via `getPartialSuccess()`.
   *
   * @param messages - The full ReAct message history
   * @param iterationCount - How many iterations were completed before hitting the limit
   * @param restartCount - How many restarts occurred
   */
  private extractPartialSuccessContext(
    messages: LlmMessage[],
    iterationCount: number,
    restartCount: number
  ): void {
    const toolCalls: { name: string; args: string; result: string }[] = [];
    const filesModified: string[] = [];
    const filesRead: string[] = [];
    const commandsRun: string[] = [];
    let lastThought = "";

    // Walk backwards through messages to find the last N tool calls and their results
    const MAX_TOOL_CALLS = 10;
    for (let i = messages.length - 1; i >= 0 && toolCalls.length < MAX_TOOL_CALLS; i--) {
      const msg = messages[i];

      if (msg.role === "assistant" && msg.content) {
        if (!lastThought) lastThought = msg.content;
      }

      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (toolCalls.length >= MAX_TOOL_CALLS) break;
          const name = tc.function.name;
          const args = tc.function.arguments;

          // Track files modified (write_edit_tool)
          if (name === "write_edit_tool") {
            try {
              const parsed = JSON.parse(args);
              if (parsed.filePath) filesModified.push(parsed.filePath);
            } catch { /* ignore parse errors */ }
          }

          // Track files read (read_tool)
          if (name === "read_tool") {
            try {
              const parsed = JSON.parse(args);
              if (parsed.filePath) filesRead.push(parsed.filePath);
            } catch { /* ignore parse errors */ }
          }

          // Track commands run (run_command_tool)
          if (name === "run_command_tool") {
            try {
              const parsed = JSON.parse(args);
              if (parsed.command) commandsRun.push(parsed.command.slice(0, 100));
            } catch { /* ignore parse errors */ }
          }

          // Find the corresponding tool result (the next tool-role message with matching id)
          let result = "";
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role === "tool" && messages[j].tool_call_id === tc.id) {
              const content = typeof messages[j].content === "string"
                ? messages[j].content
                : JSON.stringify(messages[j].content);
              result = content.slice(0, 200);
              break;
            }
          }

          toolCalls.push({ name, args: args.slice(0, 150), result });
        }
      }
    }

    // Reverse toolCalls so they're in chronological order
    toolCalls.reverse();

    this.partialSuccess = {
      toolCalls,
      filesModified: [...new Set(filesModified)], // deduplicate
      filesRead: [...new Set(filesRead)],
      commandsRun: [...new Set(commandsRun)],
      lastThought,
      iterationCount,
      restartCount,
    };
  }

  /**
   * Synthesizes a meaningful report from the message history when the orchestrator terminates
   * without a proper final answer (e.g., iteration limit hit while the model was still making
   * tool calls). This ensures the orchestrator NEVER returns an empty or meaningless string.
   *
   * The method first tries to call the LLM to generate a coherent summary of what was
   * accomplished vs. left undone. If the LLM call fails or returns empty, it falls back to
   * a mechanical reconstruction of tool calls and observations.
   *
   * The report includes:
   * - What was accomplished (tools called, files changed, observations made)
   * - What was left incomplete
   * - The last thought/state of the model
   * - The current health score and trend (e.g., "Health score: 0.8 (trending up)")
   * - A fallback message if nothing useful can be extracted
   */
  private async synthesizeReport(
    taskDescription: string,
    messages: LlmMessage[],
    currentFinalContent: string,
    maxIterations: number,
    restartCount: number
  ): Promise<string> {
    // If the model already produced a meaningful final answer (non-empty, not just a brief thought),
    // use it as-is. A "meaningful" answer is one that's longer than a typical mid-task thought
    // (e.g., "Reading file..." or "Step 1 thinking...") and doesn't end with "..." or "thinking..."
    if (currentFinalContent && currentFinalContent.length > 30) {
      const trimmed = currentFinalContent.trim();
      if (!trimmed.endsWith("...") && !trimmed.endsWith("thinking...") && !trimmed.endsWith("working...")) {
        return currentFinalContent;
      }
    }

    // Extract tool calls and observations from the message history to build a summary
    const toolActions: string[] = [];
    const observations: string[] = [];
    let lastThought = "";

    for (const msg of messages) {
      if (msg.role === "assistant" && msg.content) {
        lastThought = msg.content;
      }
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          try {
            const args = JSON.parse(tc.function.arguments);
            const argSummary = Object.keys(args).length > 0
              ? `(${Object.entries(args).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(", ")})`
              : "";
            toolActions.push(`${tc.function.name} ${argSummary}`);
          } catch {
            toolActions.push(tc.function.name);
          }
        }
      }
      if (msg.role === "tool" && msg.content) {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        observations.push(content.slice(0, 200));
      }
    }

    // CA1 (P0): Make callLlmForSummary() the PRIMARY path for summary generation.
    // Pass the FULL message history (untruncated) so the LLM has rich context for
    // generating a structured report covering what was accomplished, left undone,
    // key decisions, and blockers encountered.
    //
    // The cost of one extra LLM call at the end of a task is negligible compared
    // to the cost of the main ReAct loop. Only fall back to mechanical reconstruction
    // if the LLM call fails or returns empty.
    try {
      const llmSummary = await this.callLlmForSummary(
        taskDescription,
        messages, // pass full message history — no truncation
        maxIterations,
        restartCount
      );
      if (llmSummary && llmSummary.length > 10) {
        return llmSummary;
      }
    } catch {
      // LLM call failed — fall through to mechanical fallback
    }

    // Mechanical fallback: build a structured report from extracted data
    const parts: string[] = [];

    // Include health score and trend in the opening line
    const hs = this.memory.healthScore;
    const healthLine = `Health score: ${hs.current.toFixed(1)} (trending ${hs.trend}) — ${Math.round(hs.current * 100)}% of goal achieved`;
    parts.push(`Task stopped: hit the ${maxIterations}-iteration limit${restartCount > 0 ? ` after ${restartCount} restart(s)` : ""} without reaching a final answer.`);
    parts.push(`\n${healthLine}.`);

    if (toolActions.length > 0) {
      parts.push(`\n## What was done\n\nThe following ${toolActions.length} tool call(s) were made:\n${toolActions.map((a) => `- ${a}`).join("\n")}`);
    }

    if (lastThought) {
      parts.push(`\n## Last model thought\n\n${lastThought.slice(0, 500)}`);
    }

    if (observations.length > 0) {
      parts.push(`\n## Key observations\n\n${observations.slice(-3).map((o) => `- ${o}`).join("\n")}`);
    }

    parts.push(`\n## Next steps\n\nPartial progress may exist in the workspace. Check task_history_tool or the workspace files directly to see what was accomplished before continuing.`);

    return parts.join("\n");
  }

  /**
   * Calls the LLM to generate a structured report of what was accomplished vs. left undone
   * during a ReAct loop that hit the iteration limit. The report covers four sections:
   *
   * 1. **What was accomplished** — concrete actions taken (files read, files changed,
   *    commands run, tests executed, tool calls made)
   * 2. **What was left undone** — what the task still needs that wasn't completed
   * 3. **Key decisions made** — important choices or trade-offs made during execution
   * 4. **Blockers encountered** — errors, unexpected results, or obstacles that prevented
   *    further progress
   *
   * Returns the LLM's report text, or an empty string if the call fails.
   */
  /**
   * Calls the LLM to generate a structured report of what was accomplished vs. left undone
   * during a ReAct loop that hit the iteration limit.
   *
   * CA1+CA3 (P0): This is now the PRIMARY path for summary generation (not a fallback).
   * The FULL message history is passed without truncation so the LLM has maximum context
   * for generating a coherent summary. The cost of one extra LLM call at the end of a task
   * is negligible compared to the cost of the main ReAct loop.
   *
   * The report covers four sections:
   * 1. **What was accomplished** — concrete actions taken
   * 2. **What was left undone** — what the task still needs
   * 3. **Key decisions made** — important choices or trade-offs
   * 4. **Blockers encountered** — errors, unexpected results, or obstacles
   *
   * Returns the LLM's report text, or an empty string if the call fails.
   */
  private async callLlmForSummary(
    taskDescription: string,
    messages: LlmMessage[],
    maxIterations: number,
    restartCount: number
  ): Promise<string> {
    // Build a full conversation transcript from the message history.
    // CA3 (P0): No truncation — pass the full context so the LLM can generate
    // a rich, accurate summary. We skip the system prompt (too verbose) but
    // include everything else: user messages, assistant thoughts, tool calls,
    // and observations in their entirety.
    const transcriptParts: string[] = [];
    for (const msg of messages) {
      if (msg.role === "system") continue; // skip system prompt
      if (msg.role === "user" && msg.content) {
        transcriptParts.push(`[User] ${msg.content}`);
      } else if (msg.role === "assistant" && msg.content) {
        transcriptParts.push(`[Assistant] ${msg.content}`);
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            transcriptParts.push(`  → Tool call: ${tc.function.name}(${tc.function.arguments})`);
          }
        }
      } else if (msg.role === "tool" && msg.content) {
        const obs = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        transcriptParts.push(`  [Observation] ${obs}`);
      }
    }
    const conversationTranscript = transcriptParts.join("\n");

    // Include health score and trend in the summary prompt
    const hs = this.memory.healthScore;
    const healthLine = `Health score: ${hs.current.toFixed(1)} (trending ${hs.trend}) — ${Math.round(hs.current * 100)}% of goal achieved`;

    const summaryPrompt: LlmMessage[] = [
      {
        role: "system",
        content: "You are a summarization assistant. Given a task description and the full conversation transcript of a ReAct loop that hit its iteration limit, produce a structured report with exactly four sections:\n\n## What was accomplished\nList the concrete actions taken: files read, files changed, commands run, tests executed, tool calls made. Be specific about what was done — reference actual file paths, command outputs, and results.\n\n## What was left undone\nDescribe what the task still needs that wasn't completed. Be honest about gaps.\n\n## Key decisions made\nNote any important choices or trade-offs made during execution — e.g., which approach was chosen, what was prioritized, what was deferred.\n\n## Blockers encountered\nList any errors, unexpected results, or obstacles that prevented further progress. If none were encountered, state \"No blockers encountered.\"\n\nBe factual and concise. Use bullet points for each section. Do not include the iteration limit details — those are already known.",
      },
      {
        role: "user",
        content: `Task: ${taskDescription}\n\n${healthLine}\n\nIterations: ${maxIterations}${restartCount > 0 ? ` across ${restartCount + 1} restart(s)` : ""}\n\nFull conversation transcript:\n${conversationTranscript}`,
      },
    ];

    const response = await this.llm.complete(summaryPrompt);
    this.addUsage(response.usage);
    return response.content.trim();
  }

  /**
   * Delegates a focused task to a fresh orchestrator instance with isolated message history.
   * Returns a structured SubagentResult that includes the subagent's outcome status
   * ("completed" or "iteration_limit"), its final summary, iteration count, and — when
   * the iteration limit was hit — accumulated context (last thought, tool calls, observations)
   * so the parent orchestrator can decide whether to continue, retry, or synthesize a
   * partial report. The subagent NEVER terminates the parent just because it hit its own
   * iteration limit.
   */
  private async runSubagent(argsJson: string): Promise<SubagentResult> {
    let task: string;
    try {
      task = JSON.parse(argsJson).task;
    } catch {
      return {
        status: "completed",
        summary: "subagent_tool error: invalid arguments",
        iterationCount: 0,
      };
    }
    const sub = new ReActOrchestrator(this.llm, this.telemetry, {
      ...this.opts,
      cwd: this.cwd,
      projectRoot: this.projectRoot,
      consoleIndent: (this.opts.consoleIndent ?? 0) + 1,
    });
    const result = await sub.run(task, {
      skipPlanMode: true,
      isSubagent: true,
      suppressOnIterationLimitReached: true,
    });
    this.absorbSubagentUsage(sub);

    const subOutcome = sub.getLastOutcome();
    const iterationCount = sub.getIterationCount();

    if (subOutcome === "partial_success" || subOutcome === "iteration_limit") {
      // The subagent hit the iteration limit. Extract accumulated context from its
      // message history so the parent can make an informed decision about what to do next.
      const subMessages = sub.getLastMessages();
      const toolCalls: string[] = [];
      const observations: string[] = [];
      let lastThought = "";

      for (const msg of subMessages) {
        if (msg.role === "assistant" && msg.content) {
          lastThought = msg.content;
        }
        if (msg.role === "assistant" && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            try {
              const args = JSON.parse(tc.function.arguments);
              const argSummary = Object.keys(args).length > 0
                ? `(${Object.entries(args).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(", ")})`
                : "";
              toolCalls.push(`${tc.function.name} ${argSummary}`);
            } catch {
              toolCalls.push(tc.function.name);
            }
          }
        }
        if (msg.role === "tool" && msg.content) {
          const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          observations.push(content.slice(0, 200));
        }
      }

      return {
        status: "iteration_limit",
        summary: result,
        iterationCount,
        partialOutput: {
          lastThought,
          toolCalls,
          observations,
        },
      };
    }

    return {
      status: "completed",
      summary: result,
      iterationCount,
    };
  }

  /**
   * Generate a plan for the given task without executing it.
   * Returns the plan markdown string. Does NOT write to tasks/todo.md or prompt the user.
   * Used by the API's /chat/plan endpoint so the UI can display the plan for approval.
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
          buildProtocolPrompt(this.projectRoot) +
          "You are in Plan Mode. Do not call any tools. Produce a short, concrete, checkable " +
          "plan for the task below as a markdown checklist (`- [ ] step`), 3-8 steps. " +
          "No prose outside the checklist." +
          skillContext,
      },
      { role: "user", content: taskDescription },
    ];

    const response = await (async () => {
      if (this.opts.consoleThoughts !== false) this.io.spinnerStart("Drafting plan...");
      const res = await this.llm.complete(planPrompt);
      if (this.opts.consoleThoughts !== false) this.io.spinnerStop();
      return res;
    })();
    this.addUsage(response.usage);
    if (this.opts.consoleThoughts !== false) {
      this.io.usage(response.usage, this.cumulativeUsage.totalTokens, this.opts.consoleIndent ?? 0);
    }
    return `# Plan: ${taskDescription}\n\n${response.content.trim()}\n`;
  }

  /**
   * Plan Mode: asks the LLM (no tools, plain completion) for a short numbered plan, writes it
   * to tasks/todo.md, shows it to the user, and requires explicit confirmation before the
   * tool-calling loop begins. "Verify Plan: Check in before starting implementation."
   *
   * In non-interactive mode (API context), the plan is still generated and written to
   * .agent/tasks/todo.md, but auto-approved without a stdin prompt — the caller (e.g. /chat endpoint) is responsible
   * for returning the plan to the UI for display and approval via the /chat/plan + /chat/execute
   * two-phase flow.
   */
  private async runPlanMode(taskDescription: string, skills: LoadedSkill[]): Promise<boolean> {
    const planMarkdown = await this.generatePlan(taskDescription);
    writeTodo(this.projectRoot, planMarkdown);

    // auto mode takes highest priority — auto-approve without asking
    if (this.opts.auto) {
      this.io.log(`\n--- Plano (.agent/tasks/todo.md) ---\n${planMarkdown}`);
      this.io.log("(auto mode — awtomatikong na-approve ang plano)");
      return true;
    }

    const interactive = this.opts.interactive !== false; // default true
    if (!interactive) {
      // API context: auto-approve the plan. The caller (/chat endpoint) will return the plan
      // in the response so the UI can display it. The UI should use /chat/plan + /chat/execute
      // for the two-phase approval flow.
      this.io.log(`\n--- Plano (.agent/tasks/todo.md) ---\n${planMarkdown}`);
      this.io.log("(non-interactive mode — awtomatikong na-approve ang plano)");
      return true;
    }

    this.io.log(`\n--- Plano (.agent/tasks/todo.md) ---\n${planMarkdown}`);
    return this.io.confirm("Ituloy ang planong ito? (yes/no)", { defaultValue: false });
  }

  /**
   * Phase Planning: divides the task into multiple phases, each running as a sub-orchestrator
   * with isolated ReAct memory. Results from completed phases are summarized and passed to the
   * next phase. This reduces per-phase token footprint at the cost of losing cross-phase context
   * continuity. See enhancement/planning.md.
   *
   * The phases are generated by the LLM (no tools) as a numbered list. Each phase is then
   * executed sequentially. If a phase hits the iteration limit, the user is asked whether to
   * continue (in interactive mode) or auto-continue (in non-interactive mode).
   *
   * After all phases complete, a task history entry is written (Item 1a). Per-phase reports
   * are saved to tasks/[task_name]-phase-[N].md (Item 2a). A WBS file is generated and
   * updated as phases complete (Item 5a/5b).
   */
  private async runPhasePlanning(taskDescription: string, skills: LoadedSkill[], runOpts: RunOptions): Promise<string> {
    const skillContext = skills.length
      ? `\n\nThe following specialized skills are relevant to this task — let their guidance shape the phases:\n\n${skills
          .map((s) => `## ${s.header.name} (${s.header.role})\n${s.body}`)
          .join("\n\n")}`
      : "";

    const phasePrompt: LlmMessage[] = [
      {
        role: "system",
        content:
          buildProtocolPrompt(this.projectRoot) +
          "You are in Phase Planning Mode. Do not call any tools. " +
          "Divide the task below into 2-5 sequential phases. Each phase should be a self-contained " +
          "unit of work with its own goal. Phases are interdependent — each builds on the previous one. " +
          "The goal is to keep each phase's memory footprint small by isolating context. " +
          "Output each phase as a markdown heading (### Phase N: Title) followed by a brief description " +
          "of what that phase accomplishes. No prose outside the phase descriptions." +
          skillContext,
      },
      { role: "user", content: taskDescription },
    ];

    if (this.opts.consoleThoughts !== false) this.io.spinnerStart("Dividing task into phases...");
    const response = await this.llm.complete(phasePrompt);
    if (this.opts.consoleThoughts !== false) this.io.spinnerStop();
    this.addUsage(response.usage);

    const phasesMarkdown = response.content.trim();
    this.io.log(`\n--- Planong Phase ---\n${phasesMarkdown}\n`);

    // Parse phases from the markdown output
    const phaseRegex = /###\s*Phase\s+(\d+)[:\s]+(.+?)(?=\n###|\n*$)/gis;
    const phases: { number: number; title: string; description: string }[] = [];
    let match: RegExpExecArray | null;
    while ((match = phaseRegex.exec(phasesMarkdown)) !== null) {
      phases.push({
        number: parseInt(match[1], 10),
        title: match[2].trim(),
        description: match[0].trim(),
      });
    }

    // Derive a sanitized filename base from the task description
    const sanitizedTaskName = taskDescription
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const tasksDir = resolveTasksDir(this.projectRoot);
    fs.mkdirSync(tasksDir, { recursive: true });

    // Item 5a: Generate WBS file from phase plan
    const wbsPath = path.join(tasksDir, `${sanitizedTaskName}-wbs.md`);
    const wbsLines = phases.map((p) => `- [ ] Phase ${p.number}: ${p.title}`);
    const wbsContent = `# WBS: ${taskDescription}\n\n${wbsLines.join("\n")}\n`;
    fs.writeFileSync(wbsPath, wbsContent, "utf-8");
    this.io.log(`\n📋 Nasulat ang WBS sa .agent/tasks/${sanitizedTaskName}-wbs.md\n`);

    // If no phases were parsed, treat the whole thing as one phase
    if (phases.length === 0) {
      this.io.log("(Walang natukoy na magkakaibang phase — tatakbo bilang isang solong phase)");
      const sub = new ReActOrchestrator(this.llm, this.telemetry, {
        ...this.opts,
        cwd: this.cwd,
        projectRoot: this.projectRoot,
        consoleIndent: (this.opts.consoleIndent ?? 0) + 1,
        singlePhase: true, // prevent infinite recursion
      });
      const result = await sub.run(taskDescription, {
        ...runOpts,
        skipPlanMode: true, // subagent runs don't re-enter plan mode
        isSubagent: true,
      });
      this.absorbSubagentUsage(sub);
      return result;
    }

    // Confirm phases with user in interactive mode
    // auto mode takes highest priority — auto-approve without asking
    if (this.opts.auto) {
      this.io.log("(auto mode — awtomatikong na-approve ang phase plan)");
    } else {
      const interactive = this.opts.interactive !== false;
      if (interactive) {
        const approved = await this.io.confirm("Ituloy ang mga phase na ito? (yes/no)", { defaultValue: false });
        if (!approved) {
          this.io.log("Tinanggihan ang phase plan. Ihihinto.");
          this.lastOutcome = "plan_rejected";
          return "(No changes were made — the phase plan was not approved before execution.)";
        }
      }
    }

    // Execute each phase sequentially, passing summaries forward
    let accumulatedSummary = "";
    const phaseStats: { phaseNumber: number; phaseTitle: string; tokens: number; iterations: number; reportPath: string }[] = [];

    for (const phase of phases) {
      const phaseTask = `Phase ${phase.number}: ${phase.title}\n\n${phase.description}\n\nContext from previous phases:\n${accumulatedSummary || "(none — this is the first phase)"}\n\nComplete this phase. Do not work on future phases — focus only on what this phase requires.`;

      this.io.log(`\n=== Sinisimulan ang Phase ${phase.number}: ${phase.title} ===\n`);

      const sub = new ReActOrchestrator(this.llm, this.telemetry, {
        ...this.opts,
        cwd: this.cwd,
        projectRoot: this.projectRoot,
        consoleIndent: (this.opts.consoleIndent ?? 0) + 1,
        singlePhase: true, // prevent infinite recursion
      });
      const phaseResult = await sub.run(phaseTask, {
        ...runOpts,
        skipPlanMode: true, // subagent runs don't re-enter plan mode
        isSubagent: true,
      });
      this.absorbSubagentUsage(sub);

      // Capture per-phase stats (Item 3a)
      const phaseUsage = sub.getCumulativeUsage();
      const phaseTokens = phaseUsage.totalTokens;
      const phaseIterations = sub.getIterationCount();

      // Item 2a: Write phase report to .agent/tasks/[task_name]-phase-[N].md
      const phaseReportPath = path.join(tasksDir, `${sanitizedTaskName}-phase-${phase.number}.md`);
      const phaseReportContent = `# Phase ${phase.number}: ${phase.title}\n\n**Task:** ${taskDescription}\n\n**Result:**\n\n${phaseResult}\n\n**Stats:**\n- Tokens: ${phaseTokens.toLocaleString()}\n- Iterations: ${phaseIterations}\n`;
      fs.writeFileSync(phaseReportPath, phaseReportContent, "utf-8");
      this.io.log(`📝 Nasulat ang phase report sa .agent/tasks/${sanitizedTaskName}-phase-${phase.number}.md`);

      // Item 3b: Color-coded CLI output
      this.io.phaseStats(phase.number, phase.title, phaseTokens, phaseIterations, this.opts.consoleIndent ?? 0);

      // Persist phase report / WBS entries / phase-level task history to the database
      // (best-effort) — API-only; see persistToDb doc comment on OrchestratorOptions.
      if (this.opts.persistToDb) {
        try {
          const phaseReportStore = new PhaseReportStore();
          await phaseReportStore.save({
            taskId: sanitizedTaskName,
            phaseNumber: phase.number,
            phaseTitle: phase.title,
            content: phaseResult,
            tokens: phaseTokens,
            iterations: phaseIterations,
          });
          await phaseReportStore.close();
        } catch (err) {
          this.io.warn(`[PhaseReportStore] Nabigong i-save ang phase report: ${err instanceof Error ? err.message : String(err)}`);
        }

        try {
          const wbsStore = new WbsStore();
          await wbsStore.saveBatch(
            phases.map((p) => ({
              taskId: sanitizedTaskName,
              taskDescription: taskDescription,
              phaseNumber: p.number,
              phaseTitle: p.title,
              status: (p.number <= phase.number ? "completed" : "pending") as "completed" | "pending",
            }))
          );
          await wbsStore.close();
        } catch (err) {
          this.io.warn(`[WbsStore] Nabigong i-save ang mga WBS entry: ${err instanceof Error ? err.message : String(err)}`);
        }

        try {
          const taskHistoryStore = new TaskHistoryStore();
          await taskHistoryStore.save({
            task: `Phase ${phase.number}: ${phase.title}`,
            summary: phaseResult,
            iterations: phaseIterations,
            totalTokens: phaseTokens,
          });
          await taskHistoryStore.close();
        } catch (err) {
          this.io.warn(`[TaskHistoryStore] Nabigong i-save ang kasaysayan ng phase: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Item 5b: Update WBS to mark this phase as done
      const wbsContent = phases.map((p) => {
        const checked = p.number <= phase.number ? "x" : " ";
        return `- [${checked}] Phase ${p.number}: ${p.title}`;
      }).join("\n");
      fs.writeFileSync(wbsPath, `# WBS: ${taskDescription}\n\n${wbsContent}\n`, "utf-8");

      // Summarize what this phase accomplished for the next phase
      const summaryPrompt: LlmMessage[] = [
        {
          role: "system",
          content: "Summarize the following phase result in 2-3 sentences. Focus on what was accomplished, what files were changed, and any important state that the next phase needs to know about. Be concise.",
        },
        { role: "user", content: `Phase ${phase.number}: ${phase.title}\n\nResult:\n${phaseResult}` },
      ];

      if (this.opts.consoleThoughts !== false) this.io.spinnerStart("Summarizing phase...");
      const summaryResponse = await this.llm.complete(summaryPrompt);
      if (this.opts.consoleThoughts !== false) this.io.spinnerStop();
      this.addUsage(summaryResponse.usage);

      const phaseSummary = summaryResponse.content.trim();
      // Item 2b: Include phase report path in accumulated summary
      accumulatedSummary += `\n### Phase ${phase.number}: ${phase.title}\n${phaseSummary}\n\n_Phase report: tasks/${sanitizedTaskName}-phase-${phase.number}.md_\n`;

      phaseStats.push({
        phaseNumber: phase.number,
        phaseTitle: phase.title,
        tokens: phaseTokens,
        iterations: phaseIterations,
        reportPath: `${tasksDir}/${sanitizedTaskName}-phase-${phase.number}.md`,
      });

      this.io.log(`\n=== Nakumpleto ang Phase ${phase.number} ===\n${phaseSummary}\n`);
    }

    // Build the final result with per-phase stats
    const statsLines = phaseStats.map(
      (s) => `- **Phase ${s.phaseNumber}: ${s.phaseTitle}** — ${s.tokens.toLocaleString()} tokens, ${s.iterations} iterations (report: ${s.reportPath})`
    );
    const finalResult = `Phase planning completed.\n\n## Summary\n\n${accumulatedSummary}\n\n## Per-Phase Stats\n\n${statsLines.join("\n")}\n\nAll ${phases.length} phases completed successfully.`;

    // Item 1a: Save task report summary to task history
    appendTaskHistory(this.projectRoot, {
      task: taskDescription,
      summary: finalResult,
      iterations: phaseStats.reduce((sum, s) => sum + s.iterations, 0),
      totalTokens: this.cumulativeUsage.totalTokens || undefined,
    });

    return finalResult;
  }

  private async askContinue(taskDescription: string, maxIterations: number): Promise<boolean> {
    const interactive = this.opts.interactive !== false; // default true
    if (!interactive) {
      // API context: auto-continue rather than hanging on stdin
      this.io.log(`\nNaabot ang iteration limit (${maxIterations}) — non-interactive mode, awtomatikong magpapatuloy.`);
      return true;
    }

    this.io.log("▶ NAABOT ANG ITERATION LIMIT — Magpapatuloy?");
    return this.io.confirm(
      `Naabot ang iteration limit para sa maxIterations [${maxIterations}]: "${taskDescription}".\nMagpatuloy para sa isa pang round? (yes/no)`,
      { defaultValue: false }
    );
  }

  /**
   * Prompts the user about whether to continue a subagent that hit the iteration limit.
   * Shows the subagent's accumulated context (last thought, tool calls, observations) so
   * the user can make an informed decision. Returns true to continue, false to stop and
   * synthesize a partial report.
   *
   * In non-interactive mode (API context), auto-continues rather than hanging on stdin.
   */
  private async askContinueSubagent(
    taskDescription: string,
    iterationCount: number,
    lastThought: string,
    toolCalls: string[],
    observations: string[]
  ): Promise<boolean> {

    const interactive = this.opts.interactive !== false; // default true

    if (!interactive) {
      this.io.log(`\nNaabot ang subagent iteration limit (${iterationCount} na iterasyon) — non-interactive mode, awtomatikong magpapatuloy.`);
      return true;
    }

    this.io.log("▶ NAABOT ANG SUBAGENT ITERATION LIMIT — Magpapatuloy?");
    this.io.log(`Gawain ng subagent: "${taskDescription}"`);
    this.io.log(`Mga nakumpletong iterasyon: ${iterationCount}`);
    if (lastThought) {
      this.io.log(`Huling thought: ${lastThought.slice(0, 300)}`);
    }
    if (toolCalls.length > 0) {
      this.io.log(`Mga ginawang tool call (${toolCalls.length}):`);
      toolCalls.slice(-5).forEach((tc) => this.io.log(`  - ${tc}`));
      if (toolCalls.length > 5) {
        this.io.log(`  ... at ${toolCalls.length - 5} pa`);
      }
    }
    return this.io.confirm("Ipagpatuloy ang subagent para sa isa pang round? (yes/no)", { defaultValue: false });
  }

  /**
   * Synthesizes a partial completion report from a subagent's accumulated work when the
   * user declines to continue after an iteration limit hit. This ensures the parent
   * orchestrator gets useful information about what was accomplished, rather than an
   * empty or generic fallback message.
   *
   * The method first tries to call the LLM to generate a structured report covering:
   * what was accomplished, what was left undone, key decisions made, and blockers
   * encountered. If the LLM call fails or returns empty, it falls back to a mechanical
   * reconstruction of tool calls and observations.
   *
   * The report includes the subagent's health score and trend. If the health score is
   * above the PARTIAL_SUCCESS_THRESHOLD (0.7), the report is prefixed with "partial
   * success" messaging instead of a generic fallback, giving the parent orchestrator
   * meaningful partial-completion data.
   */
  private async synthesizeSubagentPartialReport(
    taskDescription: string,
    iterationCount: number,
    lastThought: string,
    toolCalls: string[],
    observations: string[],
    messages?: LlmMessage[]
  ): Promise<string> {
    // Determine if this is a "partial success" based on health score threshold
    const hs = this.memory.healthScore;
    const isPartialSuccess = hs.current >= 0.7;
    const healthLine = `Health score: ${hs.current.toFixed(1)} (trending ${hs.trend}) — ${Math.round(hs.current * 100)}% of goal achieved`;

    // Try to call the LLM for a coherent summary first.
    // Pass the full message history if available for richer context.
    try {
      const llmSummary = await this.callLlmForSummary(
        taskDescription,
        messages ?? [], // pass full message history — no truncation
        iterationCount,
        0
      );
      if (llmSummary && llmSummary.length > 10) {
        // Prepend the health score line to the LLM-generated summary
        return `${healthLine}\n\n${llmSummary}`;
      }
    } catch {
      // LLM call failed — fall through to mechanical fallback
    }

    // Mechanical fallback: build a structured report from extracted data
    const parts: string[] = [];

    if (isPartialSuccess) {
      parts.push(`Subagent stopped: partial success after ${iterationCount} iterations. ${healthLine}.`);
    } else {
      parts.push(`Subagent stopped: hit the iteration limit after ${iterationCount} iterations without reaching a final answer. ${healthLine}.`);
    }

    if (toolCalls.length > 0) {
      parts.push(`\n## What was done\n\nThe following ${toolCalls.length} tool call(s) were made:\n${toolCalls.map((tc) => `- ${tc}`).join("\n")}`);
    }

    if (lastThought) {
      parts.push(`\n## Last thought\n\n${lastThought.slice(0, 500)}`);
    }

    if (observations.length > 0) {
      parts.push(`\n## Key observations\n\n${observations.slice(-3).map((o) => `- ${o}`).join("\n")}`);
    }

    parts.push(`\n## Next steps\n\nPartial progress was made. The parent orchestrator should continue with the information gathered so far.`);

    return parts.join("\n");
  }
}

function classifyPhase(toolName: string, args: string): Phase {
  if (READ_ONLY_TOOLS.has(toolName)) return "search";
  if (VALIDATION_TOOLS.has(toolName)) return "validation";
  if (toolName === "github_tool") {
    try {
      const parsed = JSON.parse(args);
      return GITHUB_READ_ACTIONS.has(parsed.action) ? "search" : "action";
    } catch {
      return "action";
    }
  }
  if (ACTION_TOOLS.has(toolName)) return "action";
  if (toolName === "run_command_tool") {
    try {
      const parsed = JSON.parse(args);
      if (VALIDATION_COMMANDS.test(parsed.command ?? "")) return "validation";
    } catch {
      /* fall through */
    }
    return "action";
  }
  return "action";
}

/**
 * What actually gets stored as this step's "thought" in telemetry. `response.content` is the
 * primary source (the model's stated reasoning alongside a tool call), but some models —
 * especially when calling a tool with nothing else to say — return an empty content string and
 * put everything in `reasoning_content` instead (thinking-mode) or nothing at all. Falling back
 * to reasoningContent keeps telemetry consistent with what the live reporter already shows (see
 * AgentIO.thought(), which does the same fallback) instead of silently
 * recording "" when there was actually something to show.
 */
function deriveThought(response: { content: string; reasoningContent?: string }): string {
  return response.content || response.reasoningContent || "(no explicit reasoning before this action)";
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function buildSystemPrompt(skills: LoadedSkill[], cwd: string): string {
  const protocol = buildProtocolPrompt(cwd);

const base = `You are xcoder, a ReAct CLI agent. You have tools for searching the workspace (glob_tool, grep_tool, read_tool, list_directory_tool, find_files_tool, search_code_tool, search_ast_tool, get_dependency_graph_tool), making changes (write_edit_tool, ssh_tool, github_tool, docker_deploy_ssh_tool, schedule_task_tool), validating your work (run_command_tool, playwright_run_tool), and delegating isolated sub-tasks (subagent_tool). Follow the ReAct pattern: search for context before editing, and always validate your changes before considering a task done. Stop calling tools once the task is verified complete, and summarize what you did.

A workspace snapshot (file tree, tech stack, git status, package manifest) was already refreshed and is included below as ### Workspace context — you don't need to call workspace_info_tool just to see it. Only call workspace_info_tool(refresh=true) if that snapshot goes stale mid-task (after installing a dependency, creating/deleting files, or switching branches).

You do NOT automatically have any memory of previous tasks in this workspace — each task starts fresh. If the user says something like 'continue', 'keep going', 'what was the last task', or otherwise references earlier work without restating what it was, call task_history_tool (action='recent') before doing anything else to find out what that refers to. Don't guess or assume.

### Health Score Awareness
Your execution is tracked with a rolling health score (0-100) that measures whether your actions are making progress toward the goal. At each ReAct iteration, evaluate your progress. If your rolling health score drops below 40 (indicating repeated errors, duplicate actions, or stalled progress), propose actions that would increase it — such as re-reading the current state of files instead of assuming, trying a different approach, or verifying assumptions with a fresh tool call. After each tool call, the system automatically scores whether the action moved you closer to completion. Stay aware of this signal and adjust your strategy when the score indicates you're stuck.

### Clarification Requests
You have the ability to ask the user for clarification when you genuinely cannot proceed without more information. Use the clarification_tool to ask a question. The tool accepts:
- question (required): The specific question you need answered. Be precise and actionable.
- context (required): Brief context explaining why you're asking and what you've already determined.
- options (optional): A list of predefined choices the user can pick from.

**When to use it:**
- **Ambiguous requirements:** "Build a login system" without specifying auth method (JWT? OAuth? Session?).
- **Missing technology choices:** "Implement caching" without specifying Redis, Memcached, or in-memory.
- **Unclear constraints:** "Make it fast" without performance targets or benchmarks.
- **Contradictory instructions:** "Use SQL but also be schema-less" — ask which takes priority.
- **Missing context:** "Fix the bug" without specifying which bug, where it occurs, or how to reproduce.

**When NOT to use it:**
- Do NOT ask for clarification as a default behavior — only when genuinely uncertain.
- Do NOT ask for clarification on trivial details you can infer from context.
- Do NOT ask for clarification when you have enough information to make a reasonable choice — make the choice and proceed.
- Do NOT ask multiple questions at once — ask one question at a time.

When you call clarification_tool, execution pauses and your question is presented to the user. Their answer is injected back into your context so you can continue.`;
  const skillBlocks = skills.length
    ? `\n\nThe following specialized skill directives are loaded for this task — follow their Process/Strategies/Instructions/Planning/Experience guidance:\n\n${skills
        .map((s) => `## Skill: ${s.header.name} (${s.header.role})\n${s.body}`)
        .join("\n\n")}`
    : "";

  const workspaceInfo = readCachedWorkspaceInfo(cwd);
  const workspaceBlock = workspaceInfo ? `\n\n${summarizeWorkspaceInfo(workspaceInfo)}` : "";

  return `${protocol}<task_context>\n${base}${skillBlocks}${workspaceBlock}\n</task_context>`;
}


