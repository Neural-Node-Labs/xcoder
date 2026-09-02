import { LlmUsage, LoadedSkill, LlmMessage } from "../types.js";

/**
 * The contract any orchestration engine must implement. `ReActOrchestrator` (src/core/orchestrator.ts)
 * is the default/reference implementation, but nothing outside src/core/engine/ is allowed to
 * depend on that class directly — callers (CLI, API) go through this interface plus
 * EngineRegistry.createEngine(), so a different engine (a non-ReAct planner, a LangGraph-style
 * graph executor, a mocked engine for tests, etc.) can be dropped in without touching the CLI
 * or API call sites.
 */
export interface RunOptions {
  skipPlanMode?: boolean;
  isSubagent?: boolean;
}

export type RunOutcome = "completed" | "iteration_limit" | "plan_rejected" | "partial_success" | "partial_completion";

export interface PartialSuccessContext {
  toolCalls: { name: string; args: string; result: string }[];
  filesModified: string[];
  filesRead: string[];
  commandsRun: string[];
  lastThought: string;
  iterationCount: number;
  restartCount: number;
}

export interface SubagentLimitContext {
  lastThought: string;
  toolCalls: string[];
  observations: string[];
  iterationCount: number;
}

/**
 * Discriminated union for engine lifecycle state.
 * Each state carries the data relevant to that phase of execution.
 */
export type EngineState =
  | { phase: "idle" }
  | { phase: "planning"; task: string }
  | { phase: "running"; task: string; iteration: number; maxIterations: number }
  | { phase: "validating"; task: string; attempt: number; maxAttempts: number }
  | { phase: "cancelled"; task: string; reason: string }
  | { phase: "completed"; task: string; outcome: RunOutcome }
  | { phase: "error"; task: string; error: EngineError };

/**
 * Discriminated union for engine errors, categorizing the source of failure.
 */
export type EngineError =
  | { type: "llm"; message: string; retryable: boolean }
  | { type: "tool"; message: string; toolName: string; retryable: boolean }
  | { type: "internal"; message: string; retryable: boolean };

/**
 * Observer callback for progress reporting.
 * Called by the engine at each significant lifecycle transition.
 */
export type ProgressObserver = (state: EngineState) => void;

/**
 * Enhanced engine interface (V2) extending the base IReactEngine with lifecycle management,
 * cancellation, progress reporting, and richer state introspection.
 *
 * All new methods have default no-op implementations in the base class so existing
 * engines continue to work without modification.
 */
export interface IReactEngineV2 extends IReactEngine {
  /**
   * Cancel a running task. The engine should stop as soon as safely possible.
   * Idempotent: calling cancel() on an already-cancelled or completed engine is a no-op.
   * Postcondition: getState().phase === "cancelled"
   */
  cancel(reason?: string): void;

  /**
   * Register a progress observer. Multiple observers are supported.
   * Returns an unsubscribe function.
   */
  onProgress(observer: ProgressObserver): () => void;

  /**
   * Get the current engine lifecycle state.
   */
  getState(): EngineState;

  /**
   * Get the last ReAct message history from the most recent run() call.
   * Returns an empty array if no run has been performed.
   */
  getLastMessages(): LlmMessage[];

  /**
   * Get the effective tool-execution root for this run.
   */
  getWorkspacePath(): string;

  /**
   * Get the total number of ReAct loop iterations across all restarts for this run.
   */
  getIterationCount(): number;
}

export interface IReactEngine {
  /** Execute a task to completion (or until stopped/limited) and return the final answer text. */
  run(taskDescription: string, runOpts?: RunOptions): Promise<string>;

  /** Generate (but do not execute) a plan for the task — used by "plan preview" API endpoints. */
  generatePlan(taskDescription: string): Promise<string>;

  /** Which skills would be routed to for this task, without running anything. */
  selectSkills(taskDescription: string): LoadedSkill[];

  getLastOutcome(): RunOutcome;
  getCumulativeUsage(): LlmUsage | undefined;
  getHealthScore(): number;
  getPartialSuccess(): PartialSuccessContext | undefined;
  getSubagentLimitContext(): SubagentLimitContext | undefined;
}
