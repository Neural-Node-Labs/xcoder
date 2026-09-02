import fs from "node:fs";
import path from "node:path";
import { LlmClient, LlmUsage, TelemetryInterface, LoadedSkill, LlmMessage } from "../types.js";
import { SkillRegistry } from "../skillRegistry.js";
import { validateGoal, buildObservationTranscript } from "../goalValidator.js";
import { runCommand } from "../../tools/runCommandTool.js";
import { AgentIO } from "../io/AgentIO.js";
import { AutoIO } from "../io/AutoIO.js";
import { resolveTasksDir, resolveReportsDir } from "../../config/paths.js";
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

/**
 * SdlcEngine — a DAG-based SDLC orchestration engine, modeled on the "blueprint" reference
 * architecture (Task Factory → SDLC Orchestrator → Swarm dispatch → Validation Gate → bounded
 * healing → escalate-or-continue). Distinct from SwarmEngine: instead of an LLM-generated,
 * freeform WBS, this engine classifies intake through an explicit, ordered rule table (not an
 * inferred judgment call) into a fixed SDLC stage, builds a linear DAG of that stage plus the
 * canonical stages after it, and re-validates every stage's deliverable independently before
 * letting the DAG advance -- self_check is reported, never trusted.
 *
 * What's carried over from the blueprint, adapted to this codebase's primitives:
 * - Intake classification via an explicit rule table (classifyIntake / INTAKE_RULES below).
 * - A fixed SDLC stage pipeline with a role assigned per stage (STAGE_ROLE).
 * - A Validation Gate that re-checks each stage's deliverable independently (command | rubric).
 * - Bounded healing: a failed stage retries with a healing prompt up to maxHealingAttempts
 *   (default 2), then escalates -- a rejection report is written and the DAG halts. The
 *   engine never throws on a stage's failure; run() always returns a structured result.
 * - Each stage runs in its own isolated sub-agent (LeanEngine instance): its own transcript,
 *   its own tool calls, no shared conversation state with other stages.
 *
 * What's intentionally NOT carried over (deliberate scope cuts, not oversights):
 * - No separate CLI/server/UI stack, GitHub tools, or Playwright integration -- this engine
 *   plugs into devnull's existing tool registry, LLM client, and IO/telemetry conventions.
 * - No parallel swarm dispatch across independent DAG branches -- buildDag() currently
 *   produces a single linear chain, so frontier dispatch is sequential. The frontier-based
 *   run() loop already generalizes to concurrent branches; only buildDag() would need to grow
 *   real branching (e.g. quality-gate side-nodes) to make that useful.
 * - No sprint quality-gate DAG insertion (Scrum Master / System Architect / Security Lead
 *   gate nodes) -- noted as a natural extension point, not implemented here.
 * - Acceptance criteria default to "rubric" (independent LLM re-check) rather than requiring
 *   per-project build-tool detection; "command" criteria are supported via
 *   `acceptanceOverrides` for callers who want a real shell command re-run instead.
 */

// ─── SDLC stage pipeline ────────────────────────────────────────────────────────────

export type SdlcStage =
  | "conversation"
  | "requirements"
  | "design"
  | "code"
  | "refactor"
  | "test"
  | "ui_api_test"
  | "fix_defect"
  | "document"
  | "deploy";

/** Canonical stage order (excludes "conversation", which is a single-node side path). */
const STAGE_ORDER: SdlcStage[] = ["requirements", "design", "code", "refactor", "test", "ui_api_test", "fix_defect", "document", "deploy"];

/** Stages that only appear in the DAG when they are the classified entry point, or when the
 *  caller explicitly opts in (document/deploy) -- they are not traversed by default just
 *  because they come later in STAGE_ORDER. */
const OPTIONAL_STAGES = new Set<SdlcStage>(["refactor", "ui_api_test", "fix_defect", "document", "deploy"]);

const STAGE_ROLE: Record<SdlcStage, string> = {
  conversation: "generalist",
  requirements: "business-analyst",
  design: "architect",
  code: "programmer",
  refactor: "programmer",
  test: "tester",
  ui_api_test: "tester",
  fix_defect: "programmer",
  document: "technical-writer",
  deploy: "devops",
};

// ─── Types ────────────────────────────────────────────────────────────────────────

export interface AcceptanceCriteria {
  type: "command" | "rubric";
  /** Required when type === "command": re-run independently, exit code 0 = pass. */
  command?: string;
  /** Optional extra grading guidance appended to the rubric type's independent LLM re-check. */
  rubric?: string;
}

export interface SdlcNode {
  id: string;
  stage: SdlcStage;
  role: string;
  dependencies: string[];
  status: "pending" | "in_progress" | "completed" | "failed" | "escalated";
  acceptance: AcceptanceCriteria;
  attempts: number;
  result?: string;
  error?: string;
  iterationCount?: number;
}

/** Explicit intake signals a caller can supply, mirroring the blueprint's --url/--code/
 *  --defect/--design CLI flags. When omitted, classification falls back to keyword heuristics
 *  on the task text alone. */
export interface SdlcIntakeSignals {
  url?: string;
  hasCode?: boolean;
  hasDefect?: boolean;
  hasDesign?: boolean;
}

export interface SdlcEngineOptions {
  cwd?: string;
  io?: AgentIO;
  consoleThoughts?: boolean;
  fullContextToken?: boolean;
  selfHealing?: boolean;
  intake?: SdlcIntakeSignals;
  /** Max re-attempts per stage after the first failed validation. Default: 2. */
  maxHealingAttempts?: number;
  /** Timeout (ms) for a single stage's sub-agent. Default: 300000 (5 min). */
  agentTimeoutMs?: number;
  /** Max ReAct iterations per stage's sub-agent. Default: 15. */
  agentMaxIterations?: number;
  /** Include the "document" stage in the default pipeline. Default: false. */
  includeDocument?: boolean;
  /** Include the "deploy" stage in the default pipeline. Default: false. */
  includeDeploy?: boolean;
  /** Persist DAG state (.agent/tasks/) and rejection reports (.agent/reports/). Default: true. */
  persistArtifacts?: boolean;
  /** Per-stage acceptance-criteria overrides; falls back to `{ type: "rubric" }` otherwise. */
  acceptanceOverrides?: Partial<Record<SdlcStage, AcceptanceCriteria>>;
}

const DEFAULT_AGENT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_HEALING_ATTEMPTS = 2;

// ─── Intake classification ─────────────────────────────────────────────────────────

/**
 * Explicit, ordered, inspectable intake classification -- mirrors the blueprint's INTAKE_RULES
 * table in task-factory.ts. A rule table, not an LLM judgment call: the same inputs always
 * classify to the same starting stage, and the rules are readable top-to-bottom.
 */
export function classifyIntake(taskDescription: string, signals: SdlcIntakeSignals = {}): SdlcStage {
  const text = taskDescription.toLowerCase();
  const mentionsTest = /\btest(s|ing)?\b/.test(text);
  const mentionsDefect = /\b(bug|defect|broken|crash(es|ing)?|regression)\b/.test(text);
  const looksConversational =
    !signals.hasCode &&
    !signals.url &&
    /^(what|how|why|when|who|can you|could you|explain|tell me|is |are |do you)\b/.test(text.trim());

  if (signals.url) return "ui_api_test";
  if (signals.hasCode && (signals.hasDefect || mentionsDefect)) return "refactor";
  if (signals.hasCode && mentionsTest && !signals.hasDefect && !mentionsDefect) return "test";
  if (signals.hasDesign && !signals.hasCode) return "code";
  if (looksConversational) return "conversation";
  return "requirements";
}

// ─── DAG construction ──────────────────────────────────────────────────────────────

/**
 * Builds the SDLC DAG for a classified starting stage: a linear chain from that stage through
 * the remaining canonical stages, skipping the optional entry-point-only stages (refactor,
 * ui_api_test, fix_defect) unless they ARE the starting stage, and skipping document/deploy
 * unless the caller opted in.
 */
export function buildDag(startStage: SdlcStage, opts: SdlcEngineOptions = {}): SdlcNode[] {
  if (startStage === "conversation") {
    return [
      {
        id: "conversation",
        stage: "conversation",
        role: STAGE_ROLE.conversation,
        dependencies: [],
        status: "pending",
        attempts: 0,
        acceptance: opts.acceptanceOverrides?.conversation ?? { type: "rubric" },
      },
    ];
  }

  const startIdx = STAGE_ORDER.indexOf(startStage);
  const candidates = STAGE_ORDER.slice(startIdx);

  const stages = candidates.filter((s) => {
    if (s === startStage) return true; // always include the classified entry point
    if (s === "document") return Boolean(opts.includeDocument);
    if (s === "deploy") return Boolean(opts.includeDeploy);
    if (OPTIONAL_STAGES.has(s)) return false; // refactor/ui_api_test/fix_defect: entry-point-only
    return true; // requirements/design/code/test: the default linear backbone
  });

  return stages.map((stage, i) => ({
    id: stage,
    stage,
    role: STAGE_ROLE[stage],
    dependencies: i === 0 ? [] : [stages[i - 1]],
    status: "pending" as const,
    attempts: 0,
    acceptance: opts.acceptanceOverrides?.[stage] ?? { type: "rubric" },
  }));
}

// ─── SdlcEngine implementation ──────────────────────────────────────────────────────

export class SdlcEngine implements IReactEngine, IReactEngineV2 {
  private llm: LlmClient;
  private telemetry: TelemetryInterface;
  private opts: SdlcEngineOptions;
  private io: AgentIO;
  private cwd: string;
  private registry = new SkillRegistry();

  private state: EngineState = { phase: "idle" };
  private observers: Set<ProgressObserver> = new Set();
  private cancelled = false;

  private cumulativeUsage: LlmUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
  };
  private iterationCount = 0;
  private lastOutcome: RunOutcome = "completed";
  private lastMessages: LlmMessage[] = [];
  private nodeScores: number[] = [];

  private dag: SdlcNode[] = [];
  private taskId = "";
  private partialSuccess?: PartialSuccessContext;
  private subagentLimitContext?: SubagentLimitContext;

  constructor(llm: LlmClient, telemetry: TelemetryInterface, opts: SdlcEngineOptions = {}) {
    this.llm = llm;
    this.telemetry = telemetry;
    this.opts = opts;
    this.cwd = opts.cwd ?? process.cwd();
    this.io = opts.io ?? new AutoIO();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────────

  private transition(next: EngineState): void {
    this.state = next;
    for (const obs of this.observers) {
      try {
        obs(next);
      } catch {
        // ignore observer errors
      }
    }
  }

  private addUsage(usage?: LlmUsage): void {
    if (!usage) return;
    this.cumulativeUsage.promptTokens += usage.promptTokens || 0;
    this.cumulativeUsage.completionTokens += usage.completionTokens || 0;
    this.cumulativeUsage.totalTokens += usage.totalTokens || 0;
    this.cumulativeUsage.reasoningTokens = (this.cumulativeUsage.reasoningTokens || 0) + (usage.reasoningTokens || 0);
    this.cumulativeUsage.cachedTokens = (this.cumulativeUsage.cachedTokens || 0) + (usage.cachedTokens || 0);
  }

  private getTaskFromState(): string {
    return "task" in this.state ? (this.state as { task: string }).task : "";
  }

  // ─── IReactEngineV2 ───────────────────────────────────────────────────────────

  cancel(reason?: string): void {
    if (this.state.phase === "idle" || this.state.phase === "completed" || this.state.phase === "cancelled") {
      return;
    }
    this.cancelled = true;
    this.transition({ phase: "cancelled", task: this.getTaskFromState(), reason: reason ?? "cancelled by caller" });
  }

  onProgress(observer: ProgressObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
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

  // ─── IReactEngine ─────────────────────────────────────────────────────────────

  getLastOutcome(): RunOutcome {
    return this.lastOutcome;
  }

  getCumulativeUsage(): LlmUsage {
    return { ...this.cumulativeUsage };
  }

  /** Rolling average over the last 5 stage-validation outcomes: 100 for a first-try pass, 65
   *  for a pass that needed healing, 0 for an escalation. Not used to override the Validation
   *  Gate -- purely descriptive, matching the blueprint's "score is never a gate override". */
  getHealthScore(): number {
    if (this.nodeScores.length === 0) return 100;
    const window = this.nodeScores.slice(-5);
    return Math.round(window.reduce((a, b) => a + b, 0) / window.length);
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
    return [...names].map((n) => this.registry.loadSkill(n)).filter((s): s is LoadedSkill => Boolean(s));
  }

  async generatePlan(taskDescription: string): Promise<string> {
    const startStage = classifyIntake(taskDescription, this.opts.intake);
    const dag = buildDag(startStage, this.opts);
    const lines = [
      `## SDLC DAG Plan`,
      ``,
      `**Classified starting stage:** \`${startStage}\` (explicit intake rule table, not an inferred judgment call)`,
      ``,
      ...dag.map(
        (n) =>
          `- \`${n.id}\` — role: **${n.role}**${n.dependencies.length ? `, depends on: ${n.dependencies.join(", ")}` : ""} (acceptance: ${n.acceptance.type})`
      ),
    ];
    return lines.join("\n");
  }

  /**
   * Public entry point. Delegates to runInternal() and guarantees this promise never rejects:
   * any failure that somehow escapes every inner isolation boundary (the per-stage catch in
   * the frontier loop, runNodeWithHealing's own crash handling) is caught here as a final
   * backstop, converted into a partial_completion outcome, and a best-effort rejection report
   * is still written. "Always send a final report" holds even in the worst case.
   */
  async run(taskDescription: string, runOpts: RunOptions = {}): Promise<string> {
    try {
      return await this.runInternal(taskDescription, runOpts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.telemetry.logError(err, "SdlcEngine.run crashed outside every inner isolation boundary");
      this.lastOutcome = "partial_completion";
      this.io.error(`\n✗ SDLC engine crashed unexpectedly: ${message}`);
      let rejectionPath = "(no report path — reporting itself failed)";
      try {
        rejectionPath = this.writeRejectionReport(
          { id: "engine", stage: "requirements", role: "generalist", dependencies: [], status: "escalated", acceptance: { type: "rubric" }, attempts: 1, error: message },
          taskDescription
        );
      } catch {
        // best-effort only — see rejectionPath fallback above
      }
      const completedSummaries = this.dag
        .filter((n) => n.status === "completed")
        .map((n) => `[${n.id}] ${n.result}`)
        .join("\n\n");
      return `(SDLC engine crashed unexpectedly: ${message} — see ${rejectionPath} for details.)\n\nCompleted stages before the crash:\n${completedSummaries || "(none)"}`;
    }
  }

  private async runInternal(taskDescription: string, runOpts: RunOptions = {}): Promise<string> {
    this.transition({ phase: "planning", task: taskDescription });
    this.taskId = `sdlc-${Date.now().toString(36)}`;

    const startStage = classifyIntake(taskDescription, this.opts.intake);
    this.dag = buildDag(startStage, this.opts);

    if (!runOpts.isSubagent) {
      this.io.log(`\n--- SDLC DAG: "${taskDescription}" ---`);
      this.io.log(`Classified starting stage: ${startStage}`);
      this.io.log(`Pipeline: ${this.dag.map((n) => n.id).join(" → ")}\n`);
    }

    this.transition({ phase: "running", task: taskDescription, iteration: 0, maxIterations: this.dag.length });

    let escalated: SdlcNode | undefined;

    // Frontier loop: repeatedly find nodes whose dependencies are all completed, run them, and
    // recompute. The DAG here is a linear chain by construction (buildDag never branches), so
    // each frontier is exactly one node -- but the loop itself already generalizes to real
    // branching (e.g. parallel quality-gate side-nodes) if buildDag() grows one.
    while (!this.cancelled) {
      const completedIds = new Set(this.dag.filter((n) => n.status === "completed").map((n) => n.id));
      const frontier = this.dag.filter((n) => n.status === "pending" && n.dependencies.every((d) => completedIds.has(d)));
      if (frontier.length === 0) break;

      for (const node of frontier) {
        if (this.cancelled) break;
        node.status = "in_progress";
        this.iterationCount += 1;
        this.transition({ phase: "running", task: taskDescription, iteration: this.iterationCount, maxIterations: this.dag.length });

        // ── Isolation boundary ──────────────────────────────────────────────
        // A stage's sub-agent (and everything runNodeWithHealing does around it: dynamic
        // import, LLM calls, the Validation Gate, telemetry) runs behind this catch. Its own
        // internal try/catch already converts expected failures (a crashed sub-agent, a
        // timed-out run, a failed validation) into healing/escalation without throwing. This
        // outer catch is the backstop for anything unexpected slipping through that internal
        // handling — a bug in validateNode(), a broken dynamic import, an io.* callback
        // throwing, etc. Either way, one stage's failure is contained to that stage: it never
        // takes down the SdlcEngine run() promise itself. The DAG still gets a chance to heal
        // (the node's own attempt loop already ran), and if truly exhausted, the pipeline
        // still halts through the normal escalation path below and a final report is still
        // produced — run() never rejects because of a stage's failure, only completes with a
        // partial_completion outcome.
        let outcome: "completed" | "escalated";
        try {
          outcome = await this.runNodeWithHealing(node, taskDescription);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.telemetry.logError(err, `SdlcEngine stage ${node.id} crashed outside its own healing loop`);
          node.status = "escalated";
          node.error = `Isolation boundary caught an unexpected error: ${message}`;
          this.nodeScores.push(0);
          this.io.error(`  ✗ [${node.id}] crashed unexpectedly and was isolated: ${message}`);
          outcome = "escalated";
        }
        if (outcome === "escalated") {
          escalated = node;
          break;
        }
      }
      if (escalated) break;
    }

    this.persistState();

    if (escalated) {
      this.lastOutcome = "partial_completion";
      const rejectionPath = this.writeRejectionReport(escalated, taskDescription);
      this.transition({
        phase: "error",
        task: taskDescription,
        error: { type: "internal", message: `Stage "${escalated.id}" failed validation after ${escalated.attempts} attempt(s).`, retryable: false },
      });
      if (!runOpts.isSubagent) {
        this.io.error(`\n✗ SDLC halted at stage "${escalated.id}" after ${escalated.attempts} attempt(s). Rejection report: ${rejectionPath}`);
      }
      const completedSummaries = this.dag
        .filter((n) => n.status === "completed")
        .map((n) => `[${n.id}] ${n.result}`)
        .join("\n\n");
      return `(SDLC pipeline halted at stage "${escalated.id}" — see ${rejectionPath} for details.)\n\nCompleted stages:\n${completedSummaries}`;
    }

    if (this.cancelled) {
      this.lastOutcome = "partial_completion";
      return "(SDLC run cancelled.)";
    }

    this.lastOutcome = "completed";
    const finalAnswer = this.dag
      .filter((n) => n.status === "completed")
      .map((n) => `## ${n.id} (${n.role})\n${n.result}`)
      .join("\n\n");
    this.transition({ phase: "completed", task: taskDescription, outcome: "completed" });
    if (!runOpts.isSubagent) this.io.log(`\n✓ SDLC pipeline completed: ${this.dag.length} stage(s).`);
    return finalAnswer;
  }

  // ─── Stage execution + bounded healing ─────────────────────────────────────────

  private buildNodeDirective(node: SdlcNode, taskDescription: string, healingContext: string): string {
    const deps = node.dependencies
      .map((d) => this.dag.find((n) => n.id === d))
      .filter((n): n is SdlcNode => Boolean(n));
    const context = deps.length
      ? `\n\nContext from completed prior stage(s):\n${deps.map((d) => `[${d.id}] ${d.result}`).join("\n\n")}`
      : "";
    const healing = healingContext ? `\n\n${healingContext}` : "";
    return `You are acting as the "${node.role}" role for the "${node.stage}" stage of an SDLC pipeline.\n\nOverall task: ${taskDescription}${context}${healing}\n\nComplete this stage only. Do not work ahead into future stages.`;
  }

  /**
   * Runs one DAG node, healing on validation failure up to `maxHealingAttempts` extra tries
   * before escalating. Never throws: a crashed sub-agent or a run() timeout is treated the same
   * as a failed validation and feeds into the same healing/escalation path.
   */
  private async runNodeWithHealing(node: SdlcNode, taskDescription: string): Promise<"completed" | "escalated"> {
    const maxAttempts = this.opts.maxHealingAttempts ?? DEFAULT_MAX_HEALING_ATTEMPTS;
    let healingContext = "";

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      node.attempts = attempt + 1;
      const directive = this.buildNodeDirective(node, taskDescription, healingContext);

      const { LeanEngine } = await import("./LeanEngine.js");
      const agent = new LeanEngine(this.llm, this.telemetry, {
        cwd: this.cwd,
        maxIterations: this.opts.agentMaxIterations ?? 15,
        validateGoal: false,
        selfHealing: this.opts.selfHealing,
        consoleThoughts: this.opts.consoleThoughts ?? false,
        fullContextToken: this.opts.fullContextToken,
        io: this.io,
      });

      const timeoutMs = this.opts.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`SDLC stage "${node.id}" timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      let result: string;
      try {
        result = await Promise.race([agent.run(directive), timeout]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.telemetry.logError(err, `SdlcEngine stage ${node.id} attempt ${node.attempts}`);
        node.error = message;
        if (attempt >= maxAttempts) {
          node.status = "escalated";
          this.nodeScores.push(0);
          return "escalated";
        }
        healingContext = `Your previous attempt at this stage crashed with: ${message}\n\nTry a different approach.`;
        continue;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      node.iterationCount = agent.getIterationCount();
      this.addUsage(agent.getCumulativeUsage());
      this.lastMessages = agent.getLastMessages();

      const verdict = await this.validateNode(node, directive, agent, result);

      if (verdict.pass) {
        node.status = "completed";
        node.result = result;
        this.nodeScores.push(attempt === 0 ? 100 : 65); // full marks first try, partial credit after healing
        this.io.log(`  ✓ [${node.id}] validated (${verdict.detail})`);
        return "completed";
      }

      node.error = verdict.detail;
      this.io.warn(`  ✗ [${node.id}] validation failed (attempt ${node.attempts}/${maxAttempts + 1}): ${verdict.detail}`);
      if (attempt >= maxAttempts) {
        node.status = "escalated";
        this.nodeScores.push(0);
        return "escalated";
      }
      healingContext = `Your previous attempt at this stage did not pass validation.\n\nReason: ${verdict.detail}\n\nPrevious result:\n${result}\n\nFix the issue and try again.`;
    }

    // Unreachable given the loop bounds above, but keeps control flow exhaustive for TS.
    node.status = "escalated";
    return "escalated";
  }

  /**
   * The Validation Gate: re-checks a stage's deliverable independently. `command` re-runs the
   * declared shell command (exit 0 = pass). `rubric` (the default) asks an independent LLM call
   * to judge the deliverable against the recorded tool-observation transcript -- the same
   * mechanism as goalValidator.ts's "another agent" check. Either way, the sub-agent's own
   * claim of success is never taken at face value.
   */
  private async validateNode(
    node: SdlcNode,
    directive: string,
    agent: { getLastMessages(): LlmMessage[] },
    result: string
  ): Promise<{ pass: boolean; detail: string }> {
    const criteria = node.acceptance;

    if (criteria.type === "command" && criteria.command) {
      this.io.action("validation_gate", { stage: node.id, type: "command", command: criteria.command });
      try {
        const cmdResult = await runCommand(criteria.command, this.cwd);
        const pass = cmdResult.exitCode === 0;
        const detail = `\`${criteria.command}\` exited ${cmdResult.exitCode}`;
        this.io.observation(detail, !pass);
        return { pass, detail };
      } catch (err) {
        const detail = `command validation errored: ${err instanceof Error ? err.message : String(err)}`;
        this.io.observation(detail, true);
        return { pass: false, detail };
      }
    }

    this.io.action("validation_gate", { stage: node.id, type: "rubric" });
    const transcript = buildObservationTranscript(agent.getLastMessages());
    const rubricNote = criteria.rubric ? `\n\nAdditional acceptance rubric for this stage:\n${criteria.rubric}` : "";
    this.io.spinnerStart("Validating stage...");
    let verdict: Awaited<ReturnType<typeof validateGoal>>;
    try {
      verdict = await validateGoal(this.llm, directive + rubricNote, transcript, result);
    } finally {
      this.io.spinnerStop();
    }
    this.addUsage(verdict.usage);
    this.io.observation(verdict.reason, !verdict.valid);
    return { pass: verdict.valid, detail: verdict.reason };
  }

  // ─── Persistence ────────────────────────────────────────────────────────────────

  /** Writes DAG state to .agent/tasks/<taskId>-sdlc-state.json after the run settles, so a
   *  halted/escalated pipeline's progress is inspectable without re-running anything. */
  private persistState(): void {
    if (this.opts.persistArtifacts === false) return;
    try {
      const dir = resolveTasksDir(this.cwd);
      fs.mkdirSync(dir, { recursive: true });
      const statePath = path.join(dir, `${this.taskId}-sdlc-state.json`);
      fs.writeFileSync(statePath, JSON.stringify({ taskId: this.taskId, dag: this.dag }, null, 2), "utf-8");
    } catch (err) {
      this.io.warn(`[SdlcEngine] Failed to persist DAG state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Writes a rejection report to .agent/reports/<taskId>-<nodeId>-rejection.md when a stage
   *  exhausts its healing attempts. Mirrors the blueprint's .scrum/reports/ escalation output. */
  private writeRejectionReport(node: SdlcNode, taskDescription: string): string {
    const dir = resolveReportsDir(this.cwd);
    const reportPath = path.join(dir, `${this.taskId}-${node.id}-rejection.md`);
    const content = [
      `# SDLC Escalation: ${node.id}`,
      ``,
      `**Task:** ${taskDescription}`,
      `**Stage:** ${node.stage} (role: ${node.role})`,
      `**Attempts:** ${node.attempts}`,
      `**Last error:** ${node.error ?? "(none recorded)"}`,
      ``,
      `## Completed stages before escalation`,
      ``,
      ...this.dag.filter((n) => n.status === "completed").map((n) => `- ${n.id}: ${(n.result ?? "").slice(0, 200)}`),
    ].join("\n");

    if (this.opts.persistArtifacts !== false) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(reportPath, content, "utf-8");
      } catch (err) {
        // The report is still returned/embedded in the final answer either way -- a disk
        // error here degrades to "no file on disk" rather than losing the escalation outcome.
        this.io.warn(`[SdlcEngine] Failed to write rejection report to disk: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return reportPath;
  }
}
