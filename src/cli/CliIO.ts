import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { AgentIO, CumulativeUsage, UsageSummary } from "../core/io/AgentIO.js";
import {
  Spinner,
  reportThought,
  reportAction,
  reportObservation,
  reportSubagentStart,
  reportUsage,
  reportTotalUsage,
  reportHealthWarning,
  reportPhaseStats,
  reportTaskTokenSummary,
} from "./consoleReporter.js";

export interface CliIOOptions {
  /** Kapag false, hindi kailanman ginagalaw ng confirm() at prompt() ang stdin at ang default
   *  na lamang ang ibinabalik — ginagamit ng `--auto`/non-TTY na mga CLI invocation na gusto
   *  pa ring makakuha ng CLI-style na may-kulay na reporting. */
  interactive?: boolean;
}

/**
 * Ang karanasan sa terminal: ANSI colors, animated spinner, at tunay na y/n prompts sa stdin.
 * Ito lamang ang lugar sa codebase na dapat mag-import ng `node:readline` para sa mga engine
 * prompt — kausap ng orchestration code ang `AgentIO`, hindi kailanman diretso ang stdin.
 */
export class CliIO implements AgentIO {
  private spinner: Spinner | null = null;

  constructor(private readonly opts: CliIOOptions = {}) {}

  log(message: string): void {
    console.log(message);
  }

  warn(message: string): void {
    console.warn(message);
  }

  error(message: string): void {
    console.error(message);
  }

  thought(text: string | undefined, indent = 0): void {
    reportThought(text, indent);
  }

  action(tool: string, input: unknown, indent = 0): void {
    reportAction(tool, input, indent);
  }

  observation(observation: unknown, isError: boolean, indent = 0, score?: number): void {
    reportObservation(observation, isError, indent, score);
  }

  healthWarning(rollingAvg: number, indent = 0): void {
    reportHealthWarning(rollingAvg, indent);
  }

  subagentStart(task: string, indent = 0): void {
    reportSubagentStart(task, indent);
  }

  usage(usage: UsageSummary | undefined, runningTotal: number, indent = 0): void {
    reportUsage(usage, runningTotal, indent);
  }

  totalUsage(cumulative: CumulativeUsage, callCount: number, indent = 0): void {
    reportTotalUsage(cumulative, callCount, indent);
  }

  phaseStats(phaseNumber: number, phaseTitle: string, tokens: number, iterations: number, indent = 0): void {
    reportPhaseStats(phaseNumber, phaseTitle, tokens, iterations, indent);
  }

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
    reportTaskTokenSummary(taskTokenSummaries, indent);
  }

  spinnerStart(label: string): void {
    this.spinner = new Spinner();
    this.spinner.start(label);
  }

  spinnerStop(message?: string): void {
    this.spinner?.stop(message);
    this.spinner = null;
  }

  async confirm(message: string, opts?: { defaultValue?: boolean }): Promise<boolean> {
    const interactive = this.opts.interactive !== false;
    if (!interactive) {
      return opts?.defaultValue ?? true;
    }
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(`${message} `);
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed) return opts?.defaultValue ?? true;
      return trimmed.startsWith("y");
    } finally {
      rl.close();
    }
  }

  async prompt(question: string, opts?: { defaultValue?: string }): Promise<string | null> {
    const interactive = this.opts.interactive !== false;
    if (!interactive) {
      return opts?.defaultValue ?? null;
    }
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(`${question} `);
      const trimmed = answer.trim();
      if (!trimmed) return opts?.defaultValue ?? null;
      return trimmed;
    } finally {
      rl.close();
    }
  }
}
