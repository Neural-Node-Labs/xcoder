/**
 * AgentIO — the seam between "what the engine wants to communicate" and "how it actually gets
 * shown/asked for". Before this existed, orchestrator.ts (the ReAct engine) called
 * `console.log`/`readline` directly, which meant:
 *
 *   1. The engine could never run safely in a context with no TTY (an API server process)
 *      without every call site individually special-casing `interactive: false`.
 *   2. The engine could not be swapped for a different implementation without also dragging
 *      along CLI-only concerns (ANSI colors, spinners, stdin prompts).
 *   3. "CLI functionality" (readline prompts, terminal reporting) was physically inside the
 *      orchestration code instead of living in src/cli/, so it wasn't reusable by anything else
 *      (the API server, tests, a future TUI, etc.) and couldn't evolve independently.
 *
 * Any engine (see src/core/engine/IReactEngine.ts) depends only on this interface. Concrete
 * implementations live outside of core/: the terminal one in src/cli/CliIO.ts, and a safe
 * headless default in src/core/io/AutoIO.ts used by the API server, tests, and CI.
 */

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export interface CumulativeUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

/** One-way reporting: the engine narrates what it's doing. Never affects control flow. */
export interface AgentReporter {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;

  thought(text: string | undefined, indent?: number): void;
  action(tool: string, input: unknown, indent?: number): void;
  observation(observation: unknown, isError: boolean, indent?: number, score?: number): void;
  healthWarning(rollingAvg: number, indent?: number): void;
  subagentStart(task: string, indent?: number): void;
  usage(usage: UsageSummary | undefined, runningTotal: number, indent?: number): void;
  totalUsage(cumulative: CumulativeUsage, callCount: number, indent?: number): void;
  phaseStats(phaseNumber: number, phaseTitle: string, tokens: number, iterations: number, indent?: number): void;

  /**
   * Display per-task token usage summary.
   * Shows a breakdown by phase and the running total for each task, formatted with locale commas.
   *
   * @param taskTokenSummaries - Map of taskId ? { phases: Record<phaseId, ParsedTokenCounts>, runningTotal: number }
   * @param indent - Optional indentation level for nested output
   */
  taskTokenSummary(taskTokenSummaries: Record<string, { phases: Record<string, { input: number; output: number; cached: number; total: number; expectedTotal: number }>; runningTotal: number }>, indent?: number): void;

  /** Start/stop a "thinking..." indicator around a long-running call. Purely cosmetic. */
  spinnerStart(label: string): void;
  spinnerStop(message?: string): void;
}

/** Two-way interaction: the engine needs a yes/no decision to proceed. */
export interface AgentPrompter {
  /**
   * Ask for approval (plan review, phase-plan review, "continue past iteration limit?").
   * Implementations that have no human attached (AutoIO) resolve immediately using
   * `opts.defaultValue`. Implementations with a human attached (CliIO) actually prompt.
   */
  confirm(message: string, opts?: { defaultValue?: boolean }): Promise<boolean>;
}

/** Two-way interaction: the engine needs a free-text answer from the user. */
export interface AgentPrompterV2 {
  /**
   * Ask the user an open-ended question and wait for a text response.
   * Implementations that have no human attached (AutoIO) resolve immediately using
   * `opts.defaultValue`. Implementations with a human attached (CliIO) actually prompt.
   * Returns the user's answer as a string, or null if the user cancelled/declined to answer.
   */
  prompt(question: string, opts?: { defaultValue?: string }): Promise<string | null>;
}

export interface AgentIO extends AgentReporter, AgentPrompter, AgentPrompterV2 {}
