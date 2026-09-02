// ronin:version 2 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:46:50.869Z | ronin:subtask code-st-f034f3
// Local procedure step executor — TS semantic port of the non-SSH subset of
// the reference Python procedure_workflow runner/step_execution, over the existing tool dispatcher.
//
// Honors dependsOn / maxRetries / onFailure under workspaceRoot. Remote SSH targets are
// deferred (design D4); everything here runs locally.
import fs from "node:fs";
import path from "node:path";
import { LlmClient, ToolCall } from "../types.js";
import { dispatchToolCall } from "../../tools/toolDispatcher.js";
import { Procedure, ProcedureRunReport, ProcedureStep, StepReport } from "./types.js";

export interface ExecuteProcedureContext {
  llm: LlmClient;
  workspaceRoot: string;
  /** Called right before a step begins executing (its declared command/action). */
  onStepStart?: (step: ProcedureStep) => void;
  /** Called right after a step's report is available (whether it succeeded or failed). */
  onStepEnd?: (step: ProcedureStep, report: StepReport) => void;
}

interface RawActionResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** Execute a procedure with topological dependency ordering, retries, and onFailure policy. */
export async function executeProcedure(
  procedure: Procedure,
  ctx: ExecuteProcedureContext
): Promise<ProcedureRunReport> {
  const stepReports: StepReport[] = [];
  const reportsByStepId = new Map<string, StepReport>();
  const pending = [...procedure.steps];
  let status: ProcedureRunReport["status"] = "completed";

  // Repeatedly run steps whose dependencies have all been attempted (topo order).
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const step = pending[i];
      if (!step.dependsOn.every((dep) => reportsByStepId.has(dep))) continue;

      pending.splice(i, 1);
      progressed = true;
      ctx.onStepStart?.(step);
      const report = await executeStep(step, ctx);
      ctx.onStepEnd?.(step, report);
      stepReports.push(report);
      reportsByStepId.set(step.stepId, report);

      if (!report.ok && step.onFailure === "halt") {
        status = "halted";
        return {
          procedureId: procedure.procedureId,
          status,
          stepReports,
          finalOutput: finalize(stepReports),
        };
      }
    }
  }

  // Unresolvable dependencies (missing step ids in depends_on): mark the rest as failed.
  for (const step of pending) {
    stepReports.push({
      stepId: step.stepId,
      ok: false,
      output: "",
      error: `Step not run: dependencies could not be satisfied (${step.dependsOn.join(", ") || "none"}).`,
      attempts: 0,
    });
  }

  if (stepReports.some((r) => !r.ok)) status = "failed";
  return { procedureId: procedure.procedureId, status, stepReports, finalOutput: finalize(stepReports) };
}

function finalize(stepReports: StepReport[]): string {
  const outputs = stepReports.filter((r) => r.ok && r.output.trim()).map((r) => r.output.trim());
  return outputs.join("\n");
}

async function executeStep(step: ProcedureStep, ctx: ExecuteProcedureContext): Promise<StepReport> {
  const maxAttempts = Math.max(1, step.maxRetries);
  let command = step.command;
  let lastError: string | undefined;
  let lastOutput = "";
  let lastOk = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runStepAction(step.action, command, ctx);
    lastOk = result.ok;
    lastOutput = result.output;
    lastError = result.error;

    if (result.ok) {
      return { stepId: step.stepId, ok: true, output: result.output, attempts: attempt };
    }

    // auto_fix: ask-in-place — retry once with the error appended (design §3.6),
    // so the next attempt doesn't repeat the same broken command blindly.
    if (attempt < maxAttempts && step.onFailure === "auto_fix") {
      command = `${command}\n# ERROR from previous attempt (${result.error}); adjust the command accordingly.`;
    }
  }

  return {
    stepId: step.stepId,
    ok: lastOk,
    output: lastOutput,
    error: lastError ?? "Unknown failure",
    attempts: maxAttempts,
  };
}

async function runStepAction(
  action: ProcedureStep["action"],
  command: string,
  ctx: ExecuteProcedureContext
): Promise<RawActionResult> {
  switch (action) {
    case "shell":
      return dispatch("run_command_tool", { command }, ctx.workspaceRoot);
    case "url":
      return dispatch("summarize_url_tool", { url: command.trim() }, ctx.workspaceRoot);
    case "file":
      return runFileAction(command, ctx.workspaceRoot);
    case "llm_call":
      return runLlmCall(command, ctx);
    case "theme":
      return runTheme(command, ctx);
    default:
      return { ok: false, output: "", error: `Unsupported step action: ${String(action)}` };
  }
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  workspaceRoot: string
): Promise<RawActionResult> {
  const call: ToolCall = {
    id: `workflow_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
  const result = await dispatchToolCall(call, workspaceRoot);
  const text =
    typeof result.observation === "string"
      ? result.observation
      : JSON.stringify(result.observation ?? null, null, 2);
  return result.isError ? { ok: false, output: text, error: text } : { ok: true, output: text };
}

/**
 * File-management steps carry a JSON command mirroring procedure_workflow's FileManagementTool:
 *   {"op": "write", "path": "out.txt", "content": "hello"}
 *   {"op": "read", "path": "out.txt"}
 *   {"op": "append", "path": "out.txt", "content": "more"}
 *   {"op": "delete" | "list" | "mkdir", "path": "..."}
 * write/read go through the tool dispatcher; the remaining ops are tiny local helpers.
 */
async function runFileAction(command: string, workspaceRoot: string): Promise<RawActionResult> {
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(command || "{}");
  } catch (err) {
    return { ok: false, output: "", error: `Invalid file-management command JSON: ${err}` };
  }

  const op = String(spec.op ?? "");
  const relPath = String(spec.path ?? ".");
  const resolved = path.resolve(workspaceRoot, relPath);
  if (!resolved.startsWith(path.resolve(workspaceRoot))) {
    return { ok: false, output: "", error: `Path escapes workspace: ${relPath}` };
  }

  switch (op) {
    case "write":
      return dispatch("write_edit_tool", { mode: "write", filePath: relPath, content: String(spec.content ?? "") }, workspaceRoot);
    case "read": {
      const r = await dispatch("read_tool", { filePath: relPath }, workspaceRoot);
      return r;
    }
    case "append": {
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.appendFileSync(resolved, String(spec.content ?? ""), "utf-8");
        return { ok: true, output: `Appended to ${resolved}` };
      } catch (err) {
        return { ok: false, output: "", error: String(err) };
      }
    }
    case "delete": {
      try {
        fs.rmSync(resolved, { recursive: true, force: true });
        return { ok: true, output: `Deleted ${resolved}` };
      } catch (err) {
        return { ok: false, output: "", error: String(err) };
      }
    }
    case "list": {
      try {
        const entries = fs.readdirSync(resolved).join("\n");
        return { ok: true, output: entries || "" };
      } catch (err) {
        return { ok: false, output: "", error: String(err) };
      }
    }
    case "mkdir": {
      try {
        fs.mkdirSync(resolved, { recursive: true });
        return { ok: true, output: `Created directory ${resolved}` };
      } catch (err) {
        return { ok: false, output: "", error: String(err) };
      }
    }
    default:
      return { ok: false, output: "", error: `Unsupported op '${op}', expected one of read, write, append, delete, list, mkdir` };
  }
}

async function runLlmCall(command: string, ctx: ExecuteProcedureContext): Promise<RawActionResult> {
  if (!command || !command.trim()) {
    return { ok: false, output: "", error: "Empty prompt for llm call" };
  }
  try {
    const response = await ctx.llm.complete([{ role: "user", content: command }]);
    return { ok: true, output: response.content, error: undefined };
  } catch (err) {
    return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

const THEME_SYSTEM_PROMPT =
  "You are a theme classifier. Based on the mood/context description, reply with ONLY one word: dark or light.";

async function runTheme(command: string, ctx: ExecuteProcedureContext): Promise<RawActionResult> {
  try {
    const response = await ctx.llm.complete([
      { role: "system", content: THEME_SYSTEM_PROMPT },
      { role: "user", content: command || "neutral" },
    ]);
    const choice = response.content.trim().toLowerCase();
    const theme = choice.startsWith("light") ? "light" : "dark";
    return { ok: true, output: theme, error: undefined };
  } catch (err) {
    return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}
