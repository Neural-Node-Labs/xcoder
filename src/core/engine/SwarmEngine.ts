import fs from "node:fs";
import path from "node:path";
import {
  LlmClient,
  LlmMessage,
  LlmUsage,
  TelemetryInterface,
  ToolSchema,
  ToolCall,
  LoadedSkill,
  ReActStep,
} from "../types.js";
import { TOOL_SCHEMAS } from "../../tools/toolSchemas.js";
import { dispatchToolCall } from "../../tools/toolDispatcher.js";
import { SkillRegistry } from "../skillRegistry.js";
import { buildProtocolPrompt } from "../protocol.js";
import { validateGoal, buildObservationTranscript } from "../goalValidator.js";
import { compactStaleFileReads } from "../contextCompaction.js";
import { checkForTruncatedToolCalls, truncationWarningFor } from "../truncationGuard.js";
import { createHealthState, scoreStep, rollingHealth, HealthState } from "../stepScorer.js";
import { AgentIO } from "../io/AgentIO.js";
import { AutoIO } from "../io/AutoIO.js";
import { LeanEngine } from "./LeanEngine.js";
import {
  IReactEngine,
  IReactEngineV2,
  RunOptions,
  RunOutcome,
  PartialSuccessContext,
  SubagentLimitContext,
  EngineState,
  EngineError,
  ProgressObserver,
} from "./IReactEngine.js";

// ─── Constants ────────────────────────────────────────────────────────────────────

/** Default timeout (ms) for a single swarm agent task. 5 minutes. */
const DEFAULT_AGENT_TIMEOUT_MS = 300_000;

/** Max consecutive failures for a single task before the circuit breaker trips. */
const CIRCUIT_BREAKER_THRESHOLD = 3;

/** Cooldown iterations between self-healing nudges. */
const NUDGE_COOLDOWN = 3;

// ─── Options & Interfaces ────────────────────────────────────────────────────────

export interface SwarmEngineOptions {
  maxIterations?: number;
  cwd?: string;
  tools?: ToolSchema[];
  systemPrompt?: string;
  validateGoal?: boolean;
  maxValidatorRetries?: number;
  selfHealing?: boolean;
  consoleThoughts?: boolean;
  io?: AgentIO;
  /** Max parallel swarm agents to run concurrently. Default: 5 */
  maxParallelAgents?: number;
  /** Max iterations per swarm agent. Default: 15 */
  swarmAgentMaxIterations?: number;
  /** Whether to persist WBS and phase reports to disk. Default: true */
  persistArtifacts?: boolean;
  /** Timeout (ms) for each swarm agent task. Default: 300000 (5 min) */
  agentTimeoutMs?: number;
  /** Set to true to keep every historical read_tool observation in full (disables the default
   *  lean-token context compaction) in each swarm agent's LeanEngine. Default: false (compact). */
  fullContextToken?: boolean;
}

export interface WbsTask {
  id: string;
  description: string;
  details: string;
  dependencies: string[];
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  result?: string;
  agentId?: string;
  iterationCount?: number;
  error?: string;
  /** Circuit breaker: consecutive failure count for this task. */
  consecutiveFailures?: number;
}

interface SwarmAgentResult {
  taskId: string;
  status: "completed" | "failed" | "iteration_limit";
  summary: string;
  iterationCount: number;
  error?: string;
}

interface ValidationReport {
  iteration: number;
  score: number;
  verdict: "pass" | "warn" | "fail";
  issues: string[];
  recommendations: string[];
  healthScore: number;
}

// ─── SwarmEngine Implementation ──────────────────────────────────────────────────

export class SwarmEngine implements IReactEngine, IReactEngineV2 {
  private llm: LlmClient;
  private telemetry: TelemetryInterface;
  private opts: SwarmEngineOptions;
  private registry = new SkillRegistry();
  private io: AgentIO;
  private cwd: string;

  // Lifecycle state
  private state: EngineState = { phase: "idle" };
  private observers: Set<ProgressObserver> = new Set();
  private cancelled = false;

  // Run tracking
  private cumulativeUsage: LlmUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
  };
  private llmCallCount = 0;
  private iterationCount = 0;
  private lastOutcome: RunOutcome = "completed";
  private lastMessages: LlmMessage[] = [];
  private health: HealthState = createHealthState();
  private lastNudgeIteration = -Infinity;

  // WBS state
  private wbsTasks: WbsTask[] = [];
  private wbsPath = "";

  // Validation history
  private validationHistory: ValidationReport[] = [];

  // Partial success tracking
  private partialSuccess?: PartialSuccessContext;
  private subagentLimitContext?: SubagentLimitContext;

  constructor(llm: LlmClient, telemetry: TelemetryInterface, opts: SwarmEngineOptions = {}) {
    this.llm = llm;
    this.telemetry = telemetry;
    this.opts = opts;
    this.cwd = opts.cwd ?? process.cwd();
    this.io = opts.io ?? new AutoIO();
  }

  // ─── Helpers & Utility ─────────────────────────────────────────────────────────

  private transition(nextState: EngineState): void {
    this.state = nextState;
    for (const obs of this.observers) {
      try {
        obs(nextState);
      } catch (err) {
        // ignore observer errors
      }
    }
  }

  private addUsage(usage?: LlmUsage): void {
    if (!usage) return;
    this.llmCallCount += 1;
    this.cumulativeUsage.promptTokens += usage.promptTokens || 0;
    this.cumulativeUsage.completionTokens += usage.completionTokens || 0;
    this.cumulativeUsage.totalTokens += usage.totalTokens || 0;
    this.cumulativeUsage.reasoningTokens = (this.cumulativeUsage.reasoningTokens || 0) + (usage.reasoningTokens || 0);
    this.cumulativeUsage.cachedTokens = (this.cumulativeUsage.cachedTokens || 0) + (usage.cachedTokens || 0);
  }

  private getTaskFromState(): string {
    if ("task" in this.state) return (this.state as any).task;
    return "";
  }

  // ─── IReactEngineV2 implementation ──────────────────────────────────────────────

  cancel(reason?: string): void {
    if (this.state.phase === "idle" || this.state.phase === "completed" || this.state.phase === "cancelled") {
      return;
    }
    this.cancelled = true;
    this.transition({ phase: "cancelled", task: this.getTaskFromState(), reason: reason ?? "cancelled by caller" });
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

  getPartialSuccess(): PartialSuccessContext | undefined {
    return this.partialSuccess;
  }

  getSubagentLimitContext(): SubagentLimitContext | undefined {
    return this.subagentLimitContext;
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

  async generatePlan(taskDescription: string): Promise<string> {
    const skills = this.selectSkills(taskDescription);
    const skillContext = skills.length
      ? `\n\nThe following specialized skills are relevant to this task:\n\n${skills
          .map((s) => `## ${s.header.name} (${s.header.role})\n${s.body}`)
          .join("\n\n")}`
      : "";

    const planPrompt: LlmMessage[] = [
      {
        role: "system",
        content:
          buildProtocolPrompt(this.cwd) +
          "You are in Plan Mode for a Swarm Orchestration Engine. Do not call any tools. " +
          "Produce a detailed Work Breakdown Structure (WBS) for the task below. " +
          "Each WBS item must be a self-contained unit of work that a swarm agent can execute independently.\n" +
          "Format as a markdown table with columns: ID | Description | Dependencies | Instructions" +
          skillContext,
      },
      { role: "user", content: taskDescription },
    ];

    const response = await this.llm.complete(planPrompt);
    this.addUsage(response.usage);
    return `# Swarm Plan: ${taskDescription}\n\n${response.content.trim()}\n`;
  }

  // ─── Main Run Loop ──────────────────────────────────────────────────────────────

  async run(taskDescription: string, runOpts: RunOptions = {}): Promise<string> {
    // ── Input validation ────────────────────────────────────────────────────────
    if (!taskDescription || typeof taskDescription !== "string" || taskDescription.trim().length === 0) {
      throw new Error("SwarmEngine.run() requires a non-empty taskDescription string.");
    }

    this.cancelled = false;
    this.lastOutcome = "completed";
    this.iterationCount = 0;
    this.lastMessages = [];
    this.health = createHealthState();
    this.lastNudgeIteration = -Infinity;
    this.partialSuccess = undefined;
    this.subagentLimitContext = undefined;
    this.wbsTasks = [];
    this.validationHistory = [];

    const skills = this.selectSkills(taskDescription);
    const maxIterations = this.opts.maxIterations ?? 30;
    const selfHealingOn = this.opts.selfHealing !== false;

    this.transition({ phase: "running", task: taskDescription, iteration: 0, maxIterations });

    if (skills.length === 0) {
      this.io.log("Walang natugmang skill para sa gawaing ito. Magpapatuloy gamit ang base loop ng SwarmEngine.");
    } else {
      this.io.log(`Mga na-load na skill: ${skills.map((s) => s.header.name).join(", ")}`);
    }

    // Phase 1: Planning
    this.io.log("\n═══════════════════════════════════════════");
    this.io.log("  SWARM ENGINE — Phase 1: Planning (WBS)");
    this.io.log("═══════════════════════════════════════════\n");

    const wbsPlan = await this.generateWbs(taskDescription, skills);
    this.io.log(wbsPlan);

    this.wbsTasks = this.parseWbsTasks(wbsPlan);
    if (this.wbsTasks.length === 0) {
      this.io.log("WARNING: No tasks could be parsed from WBS plan. Falling back to single-agent mode.");
      return await this.runSingleAgent(taskDescription, skills, runOpts);
    }

    // Validate WBS dependencies (detect circular dependencies)
    const cycleErrors = this.validateWbsDependencies();
    if (cycleErrors.length > 0) {
      this.io.log(`WARNING: Circular dependencies detected in WBS:\n${cycleErrors.join("\n")}`);
      this.io.log("Falling back to single-agent mode due to invalid WBS dependencies.");
      return await this.runSingleAgent(taskDescription, skills, runOpts);
    }

    this.io.log(`\n📋 WBS: ${this.wbsTasks.length} tasks identified`);
    this.io.log(`   ${this.wbsTasks.filter((t) => t.dependencies.length === 0).length} parallel-ready tasks`);

    if (this.opts.persistArtifacts !== false) {
      this.writeWbsToDisk(taskDescription);
    }

    // Phase 2: Orchestration Loop
    this.io.log("\n═══════════════════════════════════════════");
    this.io.log("  SWARM ENGINE — Phase 2: Orchestration");
    this.io.log("═══════════════════════════════════════════\n");

    const messages: LlmMessage[] = [
      { role: "system", content: this.buildSwarmSystemPrompt(skills, taskDescription) },
      { role: "user", content: this.buildOrchestratorPrompt(taskDescription) },
    ];

    let finalContent = "";
    const swarmTools = this.getSwarmTools();

    while (this.iterationCount < maxIterations && !this.cancelled) {
      this.iterationCount++;
      this.transition({ phase: "running", task: taskDescription, iteration: this.iterationCount, maxIterations });

      // Execute auto-dispatch for ready parallel tasks (with cancellation check)
      if (!this.cancelled) {
        await this.dispatchReadyTasks();
      }

      // ── Orchestrator LLM call with error handling ──
      const showConsole = this.opts.consoleThoughts !== false;
      if (showConsole) this.io.spinnerStart("Thinking...");
      let response;
      try {
        response = await this.llm.complete(messages, { tools: swarmTools });
      } catch (err) {
        if (showConsole) this.io.spinnerStop();
        await this.telemetry.logError(err, `SwarmEngine orchestrator LLM call failed at iteration ${this.iterationCount}`);
        this.transition({
          phase: "error",
          task: taskDescription,
          error: { type: "llm", message: err instanceof Error ? err.message : String(err), retryable: true },
        });
        this.lastOutcome = "partial_success";
        this.lastMessages = messages;
        return `Swarm execution failed: orchestrator LLM error at iteration ${this.iterationCount}. ${err instanceof Error ? err.message : String(err)}`;
      }
      if (showConsole) this.io.spinnerStop();

      this.addUsage(response.usage);

      messages.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls,
        reasoning_content: response.reasoningContent,
      });
      finalContent = response.content || finalContent;

      if (showConsole) {
        if (response.toolCalls.length > 0) {
          this.io.thought(response.reasoningContent ?? response.content);
        } else if (response.reasoningContent) {
          this.io.thought(response.reasoningContent);
        }
        this.io.usage(response.usage, this.cumulativeUsage.totalTokens);
      }

      // Handle Orchestrator Tool Calls
      const { safeCalls, blockedCalls } = checkForTruncatedToolCalls(response);
      for (const blocked of blockedCalls) {
        messages.push({ role: "tool", tool_call_id: blocked.id, name: blocked.function.name, content: truncationWarningFor(blocked) });
        if (showConsole) this.io.observation(`[withheld — response truncated by token limit] ${blocked.function.name}`, true);
      }

      if (safeCalls.length > 0) {
        for (const toolCall of safeCalls) {
          if (showConsole) {
            this.io.action(toolCall.function.name, safeParseJson(toolCall.function.arguments));
          }

          const resultStr = await this.handleSwarmToolCall(toolCall);

          // Score the step for health tracking
          const isError = resultStr.startsWith("Error:");
          const score = selfHealingOn
            ? scoreStep(this.health, {
                tool: toolCall.function.name,
                args: toolCall.function.arguments,
                observation: resultStr,
                isError,
              }).score
            : undefined;
          if (showConsole) {
            this.io.observation(resultStr, isError, undefined, score);
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: resultStr,
          });

          // Context compaction (lean-token mode, default ON): collapse stale full-file
          // read_tool/write_edit_tool history for the coordinator's OWN tool calls — it has
          // direct access to the full tool set (see getSwarmTools()), not just swarm-specific
          // ones, so it's just as susceptible to unbounded context growth as any other engine.
          if (!this.opts.fullContextToken && (toolCall.function.name === "read_tool" || toolCall.function.name === "write_edit_tool")) {
            const args = safeParseFilePath(toolCall.function.arguments);
            if (args?.filePath) {
              compactStaleFileReads(messages, args.filePath, toolCall.id);
            }
          }
        }
      } else if (response.toolCalls.length === 0) {
        // If the orchestrator stopped making tool calls, evaluate status
        const allDone = this.wbsTasks.every((t) => t.status === "completed" || t.status === "failed" || t.status === "skipped");
        if (allDone) {
          break;
        } else {
          messages.push({
            role: "user",
            content: "SYSTEM NUDGE: Unfinished WBS tasks remain. Please assign pending tasks or update status.",
          });
        }
      }

      // ── Self-healing nudge ──
      if (selfHealingOn) {
        const avgHealth = rollingHealth(this.health);
        const cooldownPassed = this.iterationCount - this.lastNudgeIteration >= NUDGE_COOLDOWN;
        if (avgHealth < 40 && cooldownPassed && this.health.scores.length >= 2) {
          this.lastNudgeIteration = this.iterationCount;
          this.io.healthWarning(avgHealth);
          messages.push({
            role: "user",
            content:
              `[self-check] The orchestrator's recent actions haven't been making much progress (rolling health score: ${avgHealth}/100 — errors and/or repeated identical actions with no new information). ` +
              `Before continuing: re-read the current state of the WBS tasks rather than assuming, double-check your last assumption was actually correct, and consider a genuinely different approach instead of retrying something similar.`,
          });
        }
      }

      // Goal Validator check
      if (this.opts.validateGoal !== false) {
        await this.runGoalValidator(taskDescription);
      }
    }

    this.lastMessages = messages;

    if (this.cancelled) {
      this.lastOutcome = "partial_success";
      this.extractPartialSuccessContext(messages, this.iterationCount, 0);
      this.transition({ phase: "cancelled", task: taskDescription, reason: "Cancelled during execution" });
      return finalContent || "Execution cancelled by caller.";
    }

    const uncompleted = this.wbsTasks.filter((t) => t.status !== "completed");
    if (uncompleted.length > 0) {
      this.lastOutcome = "iteration_limit";
      this.extractPartialSuccessContext(messages, this.iterationCount, 0);
      finalContent = await this.synthesizeReport(taskDescription, messages, finalContent, maxIterations, 0);
    }

    if (this.state.phase !== "cancelled") {
      this.transition({ phase: "completed", task: taskDescription, outcome: this.lastOutcome });
    }

    if (this.opts.consoleThoughts !== false) {
      this.io.totalUsage(this.cumulativeUsage, this.llmCallCount);
      if (this.health.scores.length > 0) {
        this.io.log(`📈 Final health score: ${this.getHealthScore()}/100 (${this.health.scores.length} scored steps)`);
      }
    }

    return finalContent;
  }

  // ─── WBS Generation ────────────────────────────────────────────────────────────

  /**
   * Calls the LLM to decompose the task into a Work Breakdown Structure: a markdown
   * table with columns ID | Description | Dependencies | Instructions. Each row is a
   * self-contained unit of work a swarm agent can execute independently.
   */
  private async generateWbs(taskDescription: string, skills: LoadedSkill[]): Promise<string> {
    const skillContext = skills.length
      ? `\n\nThe following specialized skills are relevant to this task:\n\n${skills
          .map((s) => `## ${s.header.name} (${s.header.role})\n${s.body}`)
          .join("\n\n")}`
      : "";

    const wbsPrompt: LlmMessage[] = [
      {
        role: "system",
        content:
          buildProtocolPrompt(this.cwd) +
          "You are the Planning phase of a Swarm Orchestration Engine. Do not call any tools. " +
          "Decompose the task below into a Work Breakdown Structure (WBS) of 2-20 self-contained " +
          "units of work. Each unit must be independently executable by a swarm agent given only " +
          "its own Instructions column — do not assume shared context between tasks beyond what " +
          "their Dependencies declare.\n\n" +
          "Respond with ONLY a markdown table, no prose before or after, with exactly these columns:\n" +
          "| ID | Description | Dependencies | Instructions |\n\n" +
          "- ID: short identifiers like T1, T2, T3.\n" +
          "- Dependencies: comma-separated list of IDs that must complete first, or \"None\".\n" +
          "- Instructions: detailed, self-contained instructions for the swarm agent executing this task." +
          skillContext,
      },
      { role: "user", content: taskDescription },
    ];

    const response = await this.llm.complete(wbsPrompt);
    this.addUsage(response.usage);
    return response.content.trim();
  }

  /**
   * Parses a markdown WBS table into WbsTask objects. Tolerates a header row, an optional
   * markdown separator row (e.g. `| --- | --- | --- | --- |`), and blank lines. Rows that
   * don't have at least 4 cells are skipped. Returns an empty array if nothing could be parsed.
   */
  private parseWbsTasks(wbsPlan: string): WbsTask[] {
    if (!wbsPlan || !wbsPlan.trim()) return [];

    const lines = wbsPlan
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("|") && l.endsWith("|"));

    if (lines.length === 0) return [];

    const splitRow = (line: string): string[] =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());

    const isSeparatorRow = (cells: string[]): boolean =>
      cells.every((cell) => /^:?-+:?$/.test(cell));

    const isHeaderRow = (cells: string[]): boolean =>
      /^id$/i.test(cells[0] ?? "");

    const tasks: WbsTask[] = [];

    for (const line of lines) {
      const cells = splitRow(line);
      if (cells.length < 4) continue;
      if (isHeaderRow(cells)) continue;
      if (isSeparatorRow(cells)) continue;

      const [id, description, depsCell, ...instructionParts] = cells;
      if (!id) continue;

      const instructions = instructionParts.join(" | ").trim();
      const dependencies =
        !depsCell || /^none$/i.test(depsCell)
          ? []
          : depsCell
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean);

      tasks.push({
        id,
        description,
        details: instructions,
        dependencies,
        status: "pending",
        consecutiveFailures: 0,
      });
    }

    return tasks;
  }

  /**
   * Detects circular and self-referential dependencies in `this.wbsTasks` via DFS.
   * Returns a list of human-readable cycle descriptions (empty if the dependency graph is a DAG).
   */
  private validateWbsDependencies(): string[] {
    const byId = new Map(this.wbsTasks.map((t) => [t.id, t]));
    const errors: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string, path: string[]): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        const cycleStart = path.indexOf(id);
        const cycle = [...path.slice(cycleStart), id];
        errors.push(`Circular dependency detected: ${cycle.join(" -> ")}`);
        return;
      }

      const task = byId.get(id);
      if (!task) return;

      visiting.add(id);
      for (const dep of task.dependencies) {
        if (dep === id) {
          errors.push(`Self-referential dependency detected: ${id} -> ${id}`);
          continue;
        }
        if (!byId.has(dep)) continue; // unknown dependency — ignored, not a cycle
        visit(dep, [...path, id]);
      }
      visiting.delete(id);
      visited.add(id);
    };

    for (const task of this.wbsTasks) {
      visit(task.id, []);
    }

    return errors;
  }

  /** Persists the WBS plan to `.swarm_artifacts/wbs_plan.json` under the working directory. */
  private writeWbsToDisk(taskDescription: string): void {
    try {
      const dir = path.join(this.cwd, ".swarm_artifacts");
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.wbsPath = path.join(dir, "wbs_plan.json");
      fs.writeFileSync(
        this.wbsPath,
        JSON.stringify({ taskDescription, generatedAt: new Date().toISOString(), tasks: this.wbsTasks }, null, 2),
        "utf-8"
      );
    } catch (err) {
      this.io.log(`WARNING: Failed to persist WBS to disk: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Builds the orchestrator's system prompt. */
  private buildSwarmSystemPrompt(skills: LoadedSkill[], taskDescription: string): string {
    const protocol = buildProtocolPrompt(this.cwd);

    const base = `You are the Orchestrator of a Swarm Orchestration Engine for xcoder. A Work Breakdown Structure (WBS) has already been generated and is tracked internally as a set of tasks with dependencies. Your job is to drive those tasks to completion:

- Tasks with no unmet dependencies are auto-dispatched to swarm agents before each of your turns — you don't need to manually start every task yourself.
- Use swarm_check_status_tool to see the current status of all tasks.
- Use swarm_assign_tool(taskId) to manually dispatch a specific pending task.
- Use swarm_report_tool(taskId) to read the detailed result of a completed or failed task.
- You also have the standard filesystem, execution, and validation tools available if you need to inspect or verify work directly.

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

When you call clarification_tool, execution pauses and your question is presented to the user. Their answer is injected back into your context so you can continue.

Stop making tool calls once every task is completed, failed, or skipped, and summarize the overall outcome — what was accomplished, and what (if anything) failed or was skipped.`;

    const skillBlocks = skills.length
      ? `\n\nThe following specialized skill directives are loaded for this task:\n\n${skills
          .map((s) => `## Skill: ${s.header.name} (${s.header.role})\n${s.body}`)
          .join("\n\n")}`
      : "";

    return `${protocol}<task_context>\n${base}${skillBlocks}\n</task_context>`;
  }

  /** Builds the orchestrator's initial user-turn prompt, including a snapshot of the WBS. */
  private buildOrchestratorPrompt(taskDescription: string): string {
    const taskList = this.wbsTasks
      .map(
        (t) =>
          `- ${t.id} [${t.status}]: ${t.description}${t.dependencies.length ? ` (depends on: ${t.dependencies.join(", ")})` : ""}`
      )
      .join("\n");

    return (
      `Overall task: ${taskDescription}\n\n` +
      `Work Breakdown Structure (${this.wbsTasks.length} tasks):\n${taskList}\n\n` +
      "Drive these tasks to completion using the swarm tools. Ready tasks are auto-dispatched " +
      "before each of your turns — check status, and only intervene manually if something needs " +
      "attention (a failed task, a task worth re-assigning, etc.)."
    );
  }

  /** Returns the standard tool set plus the three swarm-specific orchestrator tools. */
  private getSwarmTools(): ToolSchema[] {
    const swarmTools: ToolSchema[] = [
      {
        type: "function",
        function: {
          name: "swarm_assign_tool",
          description: "Manually dispatch a WBS task to a swarm agent and wait for its result.",
          parameters: {
            type: "object",
            properties: {
              taskId: { type: "string", description: "The WBS task ID to dispatch, e.g. \"T1\"." },
            },
            required: ["taskId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "swarm_check_status_tool",
          description: "Get the current status of every WBS task as JSON.",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      {
        type: "function",
        function: {
          name: "swarm_report_tool",
          description: "Get the detailed result of a specific WBS task.",
          parameters: {
            type: "object",
            properties: {
              taskId: { type: "string", description: "The WBS task ID to report on, e.g. \"T1\"." },
            },
            required: ["taskId"],
          },
        },
      },
    ];

    return [...(this.opts.tools ?? TOOL_SCHEMAS), ...swarmTools];
  }

  // ─── Parallel Dispatch ──────────────────────────────────────────────────────────

  /**
   * Finds pending tasks whose dependencies are all completed and runs them concurrently,
   * up to `maxParallelAgents` (minus tasks already in progress).
   */
  private async dispatchReadyTasks(): Promise<void> {
    const maxParallel = this.opts.maxParallelAgents ?? 5;
    const inProgress = this.wbsTasks.filter((t) => t.status === "in_progress").length;
    const capacity = maxParallel - inProgress;
    if (capacity <= 0) return;

    const completedIds = new Set(this.wbsTasks.filter((t) => t.status === "completed").map((t) => t.id));

    const ready = this.wbsTasks.filter(
      (t) => t.status === "pending" && t.dependencies.every((d) => completedIds.has(d))
    );

    const batch = ready.slice(0, capacity);
    if (batch.length === 0) return;

    for (const task of batch) {
      task.status = "in_progress";
    }

    await Promise.all(batch.map((task) => this.runSwarmAgentForTask(task)));
  }

  /**
   * Runs a single WBS task in its own isolated LeanEngine instance, subject to
   * `agentTimeoutMs`. Updates the task's status/result/error in place and applies the
   * circuit breaker (marks the task "skipped" after CIRCUIT_BREAKER_THRESHOLD consecutive
   * failures instead of leaving it perpetually "pending"/"failed").
   */
  private async runSwarmAgentForTask(task: WbsTask): Promise<SwarmAgentResult> {
    const { LeanEngine } = await import("./LeanEngine.js");
    const timeoutMs = this.opts.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const agentId = `agent-${task.id}`;
    task.agentId = agentId;

    const agent = new LeanEngine(this.llm, this.telemetry, {
      cwd: this.cwd,
      maxIterations: this.opts.swarmAgentMaxIterations ?? 15,
      validateGoal: false,
      selfHealing: this.opts.selfHealing,
      consoleThoughts: false,
      fullContextToken: this.opts.fullContextToken,
      io: this.io,
    });

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Swarm agent for ${task.id} timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const summary = await Promise.race([agent.run(task.details || task.description), timeout]);
      task.status = "completed";
      task.result = summary;
      task.iterationCount = agent.getIterationCount();
      task.consecutiveFailures = 0;

      return { taskId: task.id, status: "completed", summary, iterationCount: task.iterationCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      task.consecutiveFailures = (task.consecutiveFailures ?? 0) + 1;
      task.error = message;
      task.iterationCount = agent.getIterationCount();

      if (task.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        task.status = "skipped";
      } else {
        task.status = "failed";
      }

      await this.telemetry.logError(err, `SwarmEngine agent failed for task ${task.id}`);
      return { taskId: task.id, status: "failed", summary: message, iterationCount: task.iterationCount ?? 0, error: message };
    }
  }

  /** Routes swarm-specific orchestrator tool calls; delegates everything else to the standard dispatcher. */
  private async handleSwarmToolCall(toolCall: ToolCall): Promise<string> {
    const name = toolCall.function.name;
    const args = safeParseJson(toolCall.function.arguments);

    if (name === "swarm_assign_tool") {
      const taskId = typeof args === "object" && args && "taskId" in args ? String((args as any).taskId) : "";
      const task = this.wbsTasks.find((t) => t.id === taskId);
      if (!task) return `Error: no WBS task with ID "${taskId}".`;
      if (task.status === "completed") return `Task ${taskId} is already completed. Result: ${task.result ?? ""}`;
      if (task.status === "in_progress") return `Task ${taskId} is already in progress.`;

      const unmet = task.dependencies.filter(
        (d) => this.wbsTasks.find((t) => t.id === d)?.status !== "completed"
      );
      if (unmet.length > 0) return `Error: task ${taskId} has unmet dependencies: ${unmet.join(", ")}.`;

      task.status = "in_progress";
      const result = await this.runSwarmAgentForTask(task);
      return result.status === "completed"
        ? `Task ${taskId} completed: ${result.summary}`
        : `Error: task ${taskId} failed: ${result.summary}`;
    }

    if (name === "swarm_check_status_tool") {
      return JSON.stringify(
        this.wbsTasks.map((t) => ({ id: t.id, description: t.description, status: t.status, dependencies: t.dependencies }))
      );
    }

    if (name === "swarm_report_tool") {
      const taskId = typeof args === "object" && args && "taskId" in args ? String((args as any).taskId) : "";
      const task = this.wbsTasks.find((t) => t.id === taskId);
      if (!task) return `Error: no WBS task with ID "${taskId}".`;
      return JSON.stringify(task);
    }

    // ── Standard tool — delegate to the shared dispatcher ──
    const result = await dispatchToolCall(toolCall, this.cwd);
    if (result.isError) {
      await this.telemetry.logError(result.observation, `tool:${result.toolName}`);
      return `Error: ${typeof result.observation === "string" ? result.observation : JSON.stringify(result.observation)}`;
    }
    return typeof result.observation === "string" ? result.observation : JSON.stringify(result.observation);
  }

  // ─── Goal Validation ────────────────────────────────────────────────────────────

  /**
   * Runs after each orchestrator iteration (when `validateGoal` is enabled). Computes a
   * completion score from the WBS task states and records a ValidationReport. Exceptions
   * are caught and silently ignored so a validator bug never crashes the orchestration loop.
   */
  private async runGoalValidator(taskDescription: string): Promise<void> {
    try {
      const total = this.wbsTasks.length;
      const completed = this.wbsTasks.filter((t) => t.status === "completed").length;
      const failed = this.wbsTasks.filter((t) => t.status === "failed" || t.status === "skipped");
      const score = total === 0 ? 100 : Math.round((completed / total) * 100);
      const verdict: ValidationReport["verdict"] = score >= 80 ? "pass" : score >= 50 ? "warn" : "fail";

      this.validationHistory.push({
        iteration: this.iterationCount,
        score,
        verdict,
        issues: failed.map((t) => `${t.id} (${t.status}): ${t.error ?? "no error message"}`),
        recommendations:
          failed.length > 0
            ? [`Review and consider re-assigning or manually resolving: ${failed.map((t) => t.id).join(", ")}`]
            : [],
        healthScore: this.getHealthScore(),
      });
    } catch {
      // Goal validator exceptions must never crash the orchestration loop
    }
  }

  // ─── Single-Agent Fallback ──────────────────────────────────────────────────────

  /**
   * Falls back to a single LeanEngine instance when WBS planning fails (no tasks parsed,
   * header-only table, or invalid/circular dependencies).
   */
  private async runSingleAgent(taskDescription: string, skills: LoadedSkill[], runOpts: RunOptions): Promise<string> {
    const { LeanEngine } = await import("./LeanEngine.js");
    const agent = new LeanEngine(this.llm, this.telemetry, {
      cwd: this.cwd,
      maxIterations: this.opts.maxIterations,
      validateGoal: this.opts.validateGoal,
      maxValidatorRetries: this.opts.maxValidatorRetries,
      selfHealing: this.opts.selfHealing,
      consoleThoughts: this.opts.consoleThoughts,
      fullContextToken: this.opts.fullContextToken,
      io: this.io,
    });

    const unsubscribe = agent.onProgress((s) => this.transition(s));

    let result: string;
    try {
      result = await agent.run(taskDescription, runOpts);
    } finally {
      unsubscribe();
    }

    this.lastOutcome = agent.getLastOutcome();
    this.lastMessages = agent.getLastMessages();
    this.iterationCount = agent.getIterationCount();
    const usage = agent.getCumulativeUsage();
    if (usage) this.addUsage(usage);
    this.partialSuccess = agent.getPartialSuccess();

    return result;
  }

  // ─── Partial Success & Reporting ────────────────────────────────────────────────

  /**
   * Extracts partial-success context from the message history when the run is cancelled
   * or hits the iteration limit. Captures the last N tool calls, their results, files
   * modified, files read, commands run, and the last assistant thought.
   */
  private extractPartialSuccessContext(messages: LlmMessage[], iterationCount: number, restartCount: number): void {
    const toolCalls: { name: string; args: string; result: string }[] = [];
    const filesModified: string[] = [];
    const filesRead: string[] = [];
    const commandsRun: string[] = [];
    let lastThought = "";

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

          if (name === "write_edit_tool") {
            try {
              const parsed = JSON.parse(args);
              if (parsed.filePath) filesModified.push(parsed.filePath);
            } catch { /* ignore parse errors */ }
          }

          if (name === "read_tool") {
            try {
              const parsed = JSON.parse(args);
              if (parsed.filePath) filesRead.push(parsed.filePath);
            } catch { /* ignore parse errors */ }
          }

          if (name === "run_command_tool") {
            try {
              const parsed = JSON.parse(args);
              if (parsed.command) commandsRun.push(parsed.command.slice(0, 100));
            } catch { /* ignore parse errors */ }
          }

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

    toolCalls.reverse();

    this.partialSuccess = {
      toolCalls,
      filesModified: [...new Set(filesModified)],
      filesRead: [...new Set(filesRead)],
      commandsRun: [...new Set(commandsRun)],
      lastThought,
      iterationCount,
      restartCount,
    };
  }

  /**
   * Synthesizes a final report from the WBS task states and message history when the
   * orchestration loop is cancelled or hits the iteration limit with uncompleted tasks.
   * Unlike LeanEngine, this is a purely mechanical reconstruction — the
   * WBS task states themselves are a more reliable source of truth here than re-asking
   * the LLM to summarize.
   */
  private async synthesizeReport(
    taskDescription: string,
    messages: LlmMessage[],
    currentFinalContent: string,
    maxIterations: number,
    restartCount: number
  ): Promise<string> {
    const completed = this.wbsTasks.filter((t) => t.status === "completed");
    const uncompleted = this.wbsTasks.filter((t) => t.status !== "completed");

    const toolActions: string[] = [];
    let lastThought = "";
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.content) lastThought = msg.content;
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolActions.push(tc.function.name);
        }
      }
    }

    const parts: string[] = [];
    parts.push(
      `Task stopped: hit the ${maxIterations}-iteration limit${restartCount > 0 ? ` after ${restartCount} restart(s)` : ""} with ${uncompleted.length} of ${this.wbsTasks.length} WBS task(s) uncompleted.`
    );

    if (currentFinalContent && currentFinalContent.trim().length > 30) {
      parts.push(`\n## Orchestrator's last statement\n\n${currentFinalContent.trim()}`);
    }

    if (completed.length > 0) {
      parts.push(`\n## Completed tasks\n\n${completed.map((t) => `- ${t.id}: ${t.description}`).join("\n")}`);
    }

    if (uncompleted.length > 0) {
      parts.push(
        `\n## Uncompleted tasks\n\n${uncompleted
          .map((t) => `- ${t.id} [${t.status}]: ${t.description}${t.error ? ` — ${t.error}` : ""}`)
          .join("\n")}`
      );
    }

    if (toolActions.length > 0) {
      parts.push(`\n## Orchestrator tool calls\n\n${toolActions.length} total: ${[...new Set(toolActions)].join(", ")}`);
    }

    if (lastThought) {
      parts.push(`\n## Last orchestrator thought\n\n${lastThought.slice(0, 500)}`);
    }

    parts.push(`\n## Next steps\n\nCheck the workspace files directly, and consider re-running the uncompleted tasks individually.`);

    return parts.join("\n");
  }
}

// ─── Standalone helper functions ──────────────────────────────────────────────────

function safeParseJson(json: string): unknown {
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
