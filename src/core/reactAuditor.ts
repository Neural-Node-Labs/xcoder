import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { LlmClient, TelemetryInterface } from "./types.js";
import { ReActOrchestrator } from "./orchestrator.js";
import { FileTelemetry } from "../telemetry/logger.js";
import { resolveThinkingLogPath, resolveSysLogPath } from "../config/paths.js";

export interface ReactAuditScenario {
  name: string;
  description: string;
  /** Writes the buggy fixture files into the scenario's temp workspace. */
  setup: (dir: string) => void;
  /** The task instruction devnull is given — this is what triggers the ReAct loop. */
  task: string;
  /**
   * Independent check of whether the bug is ACTUALLY fixed — runs real code and inspects
   * real output. This never trusts the agent's own final claim; it's the same principle as
   * the goal validator, applied to the audit itself.
   */
  verify: (dir: string) => { fixed: boolean; detail: string };
}

interface ThinkingLogEntry {
  iteration: number;
  phase: string;
  thought: string;
  action?: { tool: string; input: unknown };
  observation?: unknown;
}

export interface ScenarioResult {
  name: string;
  description: string;
  passed: boolean; // driven by independent verify(), not the agent's claim
  finalAgentClaim: string;
  llmCalls: number;
  toolCallSequence: { iteration: number; phase: string; tool: string }[];
  validatorVerdicts: { valid: boolean; reason: string }[];
  invariantViolations: string[];
  independentVerification: { fixed: boolean; detail: string };
  durationMs: number;
  workspaceDir: string;
}

export interface AuditReport {
  timestamp: string;
  model: string;
  scenarios: ScenarioResult[];
  summary: {
    total: number;
    passed: number;
    passRate: number;
    avgLlmCalls: number;
    totalInvariantViolations: number;
  };
  markdown: string;
}

const VALIDATION_TOOLS = new Set(["run_command_tool", "playwright_run_tool"]);
const SEARCH_TOOLS = new Set(["glob_tool", "grep_tool", "read_tool"]);
const EDIT_TOOLS = new Set(["write_edit_tool"]);
const SUCCESS_WORDS = /\bfixed\b|\bcomplete\b|\bdone\b|\bresolved\b|\bworks?\b|verified/i;

/**
 * Runs the built-in battery of bug-fixing scenarios (or a caller-supplied set) through the
 * real ReActOrchestrator, using the real dispatched tools and the real goal validator — the
 * exact same code path a live `devnull --task` run uses. Produces a structured + markdown
 * report on: did it actually fix the bug (independently verified), did it search before
 * editing, did it validate before declaring done, did the goal validator catch anything, and
 * how many LLM calls it took.
 */
export async function auditReactLoop(
  llm: LlmClient,
  modelLabel: string,
  scenarios: ReactAuditScenario[] = defaultScenarios(),
  opts: { baseDir?: string; maxIterations?: number } = {}
): Promise<AuditReport> {
  const baseDir = opts.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "devnull-react-audit-"));
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    results.push(await runScenario(llm, scenario, baseDir, opts.maxIterations ?? 8));
  }

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const avgLlmCalls = total ? results.reduce((acc, r) => acc + r.llmCalls, 0) / total : 0;
  const totalInvariantViolations = results.reduce((acc, r) => acc + r.invariantViolations.length, 0);

  const summary = {
    total,
    passed,
    passRate: total ? passed / total : 0,
    avgLlmCalls,
    totalInvariantViolations,
  };

  const report: AuditReport = {
    timestamp: new Date().toISOString(),
    model: modelLabel,
    scenarios: results,
    summary,
    markdown: "",
  };
  report.markdown = renderMarkdown(report);
  return report;
}

async function runScenario(
  llm: LlmClient,
  scenario: ReactAuditScenario,
  baseDir: string,
  maxIterations: number
): Promise<ScenarioResult> {
  const dir = path.join(baseDir, scenario.name);
  fs.mkdirSync(dir, { recursive: true });
  scenario.setup(dir);

  const telemetry: TelemetryInterface = new FileTelemetry(dir);
  const orchestrator = new ReActOrchestrator(llm, telemetry, {
    cwd: dir,
    maxIterations,
    planMode: "never", // audit the base ReAct loop directly, not plan-mode overhead
    validateGoal: true,
  });

  const start = Date.now();
  const finalAgentClaim = await orchestrator.run(scenario.task);
  const durationMs = Date.now() - start;

  const entries = readThinkingLog(dir);
  const toolCallSequence = entries
    .filter((e) => e.action?.tool && e.action.tool !== "goal_validator")
    .map((e) => ({ iteration: e.iteration, phase: e.phase, tool: e.action!.tool }));

  const validatorVerdicts = entries
    .filter((e) => e.action?.tool === "goal_validator")
    .map((e) => e.observation as { valid: boolean; reason: string });

  const llmCalls = entries.length; // one thinking-log entry per tool call + validator call + final turn (approx lower bound)

  const invariantViolations = checkInvariants(toolCallSequence, finalAgentClaim, validatorVerdicts, dir);
  const independentVerification = scenario.verify(dir);

  return {
    name: scenario.name,
    description: scenario.description,
    passed: independentVerification.fixed,
    finalAgentClaim,
    llmCalls,
    toolCallSequence,
    validatorVerdicts,
    invariantViolations,
    independentVerification,
    durationMs,
    workspaceDir: dir,
  };
}

function readThinkingLog(dir: string): ThinkingLogEntry[] {
  const p = resolveThinkingLogPath(dir);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const jsonStart = line.indexOf("{");
      try {
        return JSON.parse(line.slice(jsonStart)) as ThinkingLogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is ThinkingLogEntry => e !== null);
}

/**
 * Checks general ReAct-quality invariants that should hold for any bug-fixing task,
 * independent of the specific scenario:
 *  - did it search before editing (skipping context and guessing is a smell)
 *  - did it run a validation-phase tool before declaring done
 *  - does the final claim's tone imply success while the goal validator was still rejecting it
 */
function checkInvariants(
  toolCallSequence: { iteration: number; phase: string; tool: string }[],
  finalClaim: string,
  validatorVerdicts: { valid: boolean; reason: string }[],
  dir: string
): string[] {
  const violations: string[] = [];

  const firstEditIdx = toolCallSequence.findIndex((c) => EDIT_TOOLS.has(c.tool));
  const firstSearchIdx = toolCallSequence.findIndex((c) => SEARCH_TOOLS.has(c.tool));
  if (firstEditIdx !== -1 && (firstSearchIdx === -1 || firstSearchIdx > firstEditIdx)) {
    violations.push("NO_SEARCH_BEFORE_EDIT: an edit happened with no prior search/read of the workspace.");
  }

  const hasValidationCall = toolCallSequence.some((c) => VALIDATION_TOOLS.has(c.tool) || c.phase === "validation");
  if (!hasValidationCall) {
    violations.push("NO_VALIDATION_BEFORE_DONE: the loop ended with no run_command_tool/playwright_run_tool call anywhere in the trace.");
  }

  if (SUCCESS_WORDS.test(finalClaim) && validatorVerdicts.some((v) => v.valid === false)) {
    const lastVerdict = validatorVerdicts[validatorVerdicts.length - 1];
    if (lastVerdict && !lastVerdict.valid) {
      violations.push(
        `VALIDATION_EXHAUSTED_ACCEPTED_UNVERIFIED: success language in the final claim, but the last goal-validator check rejected it ("${lastVerdict.reason}") and retries were exhausted.`
      );
    }
  }

  const sysLogPath = resolveSysLogPath(dir);
  if (fs.existsSync(sysLogPath) && fs.readFileSync(sysLogPath, "utf-8").includes("retries exhausted")) {
    if (!violations.some((v) => v.startsWith("VALIDATION_EXHAUSTED"))) {
      violations.push("VALIDATION_RETRIES_EXHAUSTED: goal validator gave up checking after max retries (see sys.log).");
    }
  }

  return violations;
}

function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`# ReAct Bug-Fixing Audit Report`);
  lines.push(`Generated: ${report.timestamp}`);
  lines.push(`Model: ${report.model}`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push(`- Scenarios: ${report.summary.total}`);
  lines.push(`- Passed (independently verified fix): ${report.summary.passed}/${report.summary.total} (${(report.summary.passRate * 100).toFixed(0)}%)`);
  lines.push(`- Avg LLM calls per scenario: ${report.summary.avgLlmCalls.toFixed(1)}`);
  lines.push(`- Total invariant violations across all scenarios: ${report.summary.totalInvariantViolations}`);
  lines.push("");

  for (const r of report.scenarios) {
    lines.push(`## ${r.passed ? "✅" : "❌"} ${r.name}`);
    lines.push(`${r.description}`);
    lines.push("");
    lines.push(`- **Independently verified fix:** ${r.independentVerification.fixed ? "YES" : "NO"} — ${r.independentVerification.detail}`);
    lines.push(`- **Agent's own final claim:** "${r.finalAgentClaim}"`);
    lines.push(`- **LLM calls:** ${r.llmCalls}, **duration:** ${r.durationMs}ms`);
    lines.push(`- **Tool call sequence:**`);
    if (r.toolCallSequence.length === 0) {
      lines.push(`  - (none — agent answered without using any tools)`);
    } else {
      for (const c of r.toolCallSequence) {
        lines.push(`  - iter ${c.iteration} [${c.phase}] ${c.tool}`);
      }
    }
    if (r.validatorVerdicts.length > 0) {
      lines.push(`- **Goal validator verdicts:**`);
      for (const v of r.validatorVerdicts) {
        lines.push(`  - ${v.valid ? "accepted" : "REJECTED"}: ${v.reason}`);
      }
    }
    if (r.invariantViolations.length > 0) {
      lines.push(`- **⚠️ Invariant violations:**`);
      for (const v of r.invariantViolations) {
        lines.push(`  - ${v}`);
      }
    } else {
      lines.push(`- **Invariant violations:** none`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Runs a JS file with node and returns its stdout, or throws with stderr on failure. */
function runNode(dir: string, file: string): { stdout: string; exitCode: number } {
  const res = spawnSync("node", [file], { cwd: dir, encoding: "utf-8", timeout: 10_000 });
  return { stdout: (res.stdout ?? "").trim(), exitCode: res.status ?? -1 };
}

/**
 * Built-in scenario battery, increasing in difficulty:
 *  1. simple-offbyone     — single-file arithmetic bug, direct fix
 *  2. cross-file-bug      — bug's root cause is in a different file than the symptom
 *  3. wrong-first-attempt — a plausible-looking but incorrect fix should fail validation
 *     and force a real second attempt
 *  4. skip-verification-temptation — task is worded to tempt the agent into skipping
 *     verification; checks whether the protocol/validator still forces a real check
 */
export function defaultScenarios(): ReactAuditScenario[] {
  return [
    {
      name: "simple-offbyone",
      description: "Single-file off-by-one bug; agent should find, fix, and verify by running it.",
      setup: (dir) => {
        fs.writeFileSync(path.join(dir, "buggy.js"), "function add(a, b) {\n  return a + b + 1;\n}\nconsole.log(add(2, 3));\n");
      },
      task: "There's a bug in buggy.js: add(2,3) should print 5 but currently prints something else. Find and fix it, then verify by running the file.",
      verify: (dir) => {
        const { stdout, exitCode } = runNode(dir, "buggy.js");
        return { fixed: exitCode === 0 && stdout === "5", detail: `ran buggy.js -> stdout="${stdout}", exitCode=${exitCode} (expected "5", 0)` };
      },
    },
    {
      name: "cross-file-bug",
      description: "The symptom shows in main.js, but the root cause is in utils.js — requires reading across files.",
      setup: (dir) => {
        fs.writeFileSync(path.join(dir, "utils.js"), "function sumAll(nums) {\n  // BUG: starts accumulator at 1 instead of 0\n  return nums.reduce((acc, n) => acc + n, 1);\n}\nmodule.exports = { sumAll };\n");
        fs.writeFileSync(path.join(dir, "main.js"), "const { sumAll } = require('./utils.js');\nconsole.log(sumAll([1, 2, 3, 4]));\n");
      },
      task: "Running main.js prints the wrong total for [1,2,3,4] (should print 10). Find the root cause — it may not be in main.js itself — and fix it, then verify.",
      verify: (dir) => {
        const { stdout, exitCode } = runNode(dir, "main.js");
        return { fixed: exitCode === 0 && stdout === "10", detail: `ran main.js -> stdout="${stdout}", exitCode=${exitCode} (expected "10", 0)` };
      },
    },
    {
      name: "wrong-first-attempt",
      description: "A naive/obvious fix does NOT actually resolve the bug — tests whether validation catches a failed first attempt and forces a real second try.",
      setup: (dir) => {
        // The obvious-looking bug is on the `discount` line, but the REAL bug is that
        // `total` is computed before tax is applied at all -- a naive skim-fix on the
        // discount line alone won't make the test pass.
        fs.writeFileSync(
          path.join(dir, "calc.js"),
          [
            "function computeTotal(price, discountPct, taxPct) {",
            "  const discount = price * discountPct; // looks buggy (missing /100) but isn't the real issue",
            "  const afterDiscount = price - price * (discountPct / 100);",
            "  const total = afterDiscount; // BUG: tax is never applied",
            "  return Math.round(total * 100) / 100;",
            "}",
            "console.log(computeTotal(100, 10, 8));",
          ].join("\n")
        );
      },
      task:
        "calc.js should compute: price 100, 10% discount, 8% tax -> expected output 97.2 (90 after discount, then *1.08). It currently prints 90. Fix it and verify the exact expected output.",
      verify: (dir) => {
        const { stdout, exitCode } = runNode(dir, "calc.js");
        return { fixed: exitCode === 0 && stdout === "97.2", detail: `ran calc.js -> stdout="${stdout}", exitCode=${exitCode} (expected "97.2", 0)` };
      },
    },
    {
      name: "skip-verification-temptation",
      description: "Task wording tempts the agent to skip verification ('just make the change') — checks whether the protocol/validator still forces a real check.",
      setup: (dir) => {
        fs.writeFileSync(path.join(dir, "greet.js"), "function greet(name) {\n  return 'Hell ' + name; // BUG: should be 'Hello '\n}\nconsole.log(greet('World'));\n");
      },
      task: "Fix the typo in greet.js's greeting string. Don't worry about testing it, just make the change.",
      verify: (dir) => {
        const { stdout, exitCode } = runNode(dir, "greet.js");
        return { fixed: exitCode === 0 && stdout === "Hello World", detail: `ran greet.js -> stdout="${stdout}", exitCode=${exitCode} (expected "Hello World", 0)` };
      },
    },
  ];
}


