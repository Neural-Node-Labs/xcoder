import { AgentIO, CumulativeUsage, UsageSummary } from "./AgentIO.js";

export interface AutoIOOptions {
  /** Default answer returned by confirm() when no explicit defaultValue is supplied. Default: true. */
  defaultAnswer?: boolean;
  /** Suppress all console output (reporter methods become no-ops). Default: false. */
  silent?: boolean;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function summarize(value: unknown): string {
  try {
    const json = typeof value === "string" ? value : JSON.stringify(value);
    return truncate(json, 300);
  } catch {
    return String(value);
  }
}

function prefix(indent: number): string {
  return indent > 0 ? "  ".repeat(indent) + "↳ " : "";
}

/**
 * The default AgentIO for any non-interactive context: the API server, automated diagnostics,
 * CI, unit tests. Never reads stdin — every confirm() resolves immediately — so an engine
 * running headless can never hang waiting on a prompt nobody will answer.
 *
 * Still writes plain (non-ANSI, non-spinner) lines to console by default so server logs remain
 * useful; pass `{ silent: true }` to suppress that entirely.
 */
export class AutoIO implements AgentIO {
  constructor(private readonly opts: AutoIOOptions = {}) {}

/**
   * Non-interactive prompt implementation for head-less / automated runs.
   */
  async prompt(question: string, opts?: { defaultValue?: string }): Promise<string | null> {
    return opts?.defaultValue ?? null;
  }

  /**
   * Token summary output handler for task reporting.
   */
  taskTokenSummary(
    taskTokenSummaries: Record<
      string,
      {
        phases: Record<string, { input: number; output: number; cached: number; total: number; expectedTotal: number }>;
        runningTotal: number;
      }
    >,
    indent = 0
  ): void {
    if (this.opts.silent) return;
    // Implementation or no-op depending on silent option
  }


  private write(line: string): void {
    if (!this.opts.silent) console.log(line);
  }

  log(message: string): void {
    this.write(message);
  }

  warn(message: string): void {
    if (!this.opts.silent) console.warn(message);
  }

  error(message: string): void {
    if (!this.opts.silent) console.error(message);
  }

  thought(text: string | undefined, indent = 0): void {
    if (!text || !text.trim()) return;
    this.write(`${prefix(indent)}[THOUGHT] ${truncate(text.trim(), 500)}`);
  }

  action(tool: string, input: unknown, indent = 0): void {
    this.write(`${prefix(indent)}[ACTION] ${tool} ${summarize(input)}`);
  }

  observation(observation: unknown, isError: boolean, indent = 0, score?: number): void {
    const label = isError ? "[OBSERVATION:error]" : "[OBSERVATION]";
    const scoreBit = score === undefined ? "" : ` [health ${score}]`;
    this.write(`${prefix(indent)}${label} ${summarize(observation)}${scoreBit}`);
  }

  healthWarning(rollingAvg: number, indent = 0): void {
    this.write(`${prefix(indent)}[SELF-CHECK] rolling health ${rollingAvg}/100 — nudging the agent to reconsider its approach`);
  }

  subagentStart(task: string, indent = 0): void {
    this.write(`${prefix(indent)}[SUBAGENT] ${truncate(task, 200)}`);
  }

  usage(usage: UsageSummary | undefined, runningTotal: number, indent = 0): void {
    if (!usage) return;
    const bits = [`${usage.promptTokens} in`, `${usage.completionTokens} out`];
    if (usage.reasoningTokens) bits.push(`${usage.reasoningTokens} reasoning`);
    if (usage.cachedTokens) bits.push(`${usage.cachedTokens} cached`);
    this.write(`${prefix(indent)}[USAGE] ${bits.join(" · ")} — ${runningTotal} total this run`);
  }

  totalUsage(cumulative: CumulativeUsage, callCount: number, indent = 0): void {
    if (callCount === 0) return;
    const reasoningBit = cumulative.reasoningTokens ? ` (${cumulative.reasoningTokens} reasoning)` : "";
    this.write(
      `${prefix(indent)}[TOTAL USAGE] ${cumulative.totalTokens} tokens${reasoningBit} — ${cumulative.promptTokens} in · ${cumulative.completionTokens} out across ${callCount} LLM call(s)`
    );
  }

  phaseStats(phaseNumber: number, phaseTitle: string, tokens: number, iterations: number, indent = 0): void {
    this.write(`${prefix(indent)}[PHASE] ${phaseNumber}: ${phaseTitle} — ${tokens} tokens · ${iterations} iterations`);
  }

  spinnerStart(_label: string): void {
    // No animation in headless contexts — nothing to draw to.
  }

  spinnerStop(_message?: string): void {
    // no-op
  }

  async confirm(message: string, opts?: { defaultValue?: boolean }): Promise<boolean> {
    const answer = opts?.defaultValue ?? this.opts.defaultAnswer ?? true;
    this.write(`${message} (headless mode — auto-answering "${answer ? "yes" : "no"}")`);
    return answer;
  }
}
