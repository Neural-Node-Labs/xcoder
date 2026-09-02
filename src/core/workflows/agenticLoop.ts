// ronin:version 2 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:46:43.968Z | ronin:subtask code-st-f034f3
// Deterministic agentic ReAct loop — TS semantic port of
// the reference Python agentic_workflow/orchestrator.py.
//
// The loop itself never calls an LLM: it is driven by an injected ThinkFn, which keeps it
// deterministic and unit-testable without a live model (AC-4 smoke-test seam).
import { AgentDecision, AgentRunContext, AgentRunReport, ThinkFn, WorkflowToolContext } from "./types.js";

/**
 * Run the agentic loop for a task until done, failed, or iteration maxout.
 * `think` is the single-step decision driver; `tools` is the thin facade over
 * the existing tool layer (toolDispatcher) that executes the decided action.
 */
export async function runAgenticLoop(
  taskDescription: string,
  maxIterations: number,
  think: ThinkFn,
  tools: WorkflowToolContext
): Promise<AgentRunReport> {
  const report: AgentRunReport = {
    taskDescription,
    status: "running",
    iterationsUsed: 0,
    maxIterations,
    trace: [],
    finalAnswer: "",
  };
  return loop(report, think, tools);
}

/**
 * Resumes a needs_continuation report for another `extraIterations` (mirrors
 * agentic_workflow AgenticOrchestrator.continue_run).
 */
export async function continueAgenticLoop(
  report: AgentRunReport,
  extraIterations: number,
  think: ThinkFn,
  tools: WorkflowToolContext
): Promise<AgentRunReport> {
  report.maxIterations += extraIterations;
  report.status = "running";
  return loop(report, think, tools);
}

async function loop(report: AgentRunReport, think: ThinkFn, tools: WorkflowToolContext): Promise<AgentRunReport> {
  while (report.iterationsUsed < report.maxIterations) {
    report.iterationsUsed += 1;

    const ctx: AgentRunContext = {
      taskDescription: report.taskDescription,
      iterationsUsed: report.iterationsUsed,
      maxIterations: report.maxIterations,
      trace: report.trace,
      workspaceRoot: tools.workspaceRoot,
    };

    let decision: AgentDecision;
    try {
      decision = await think(ctx, tools);
    } catch (err) {
      // A broken "think" step must not crash the loop (mirrors Python).
      report.status = "failed";
      report.finalAnswer = `Stopped: thinking step raised an error: ${err instanceof Error ? err.message : String(err)}`;
      return report;
    }

    if (decision.done || !decision.tool || decision.tool === "none") {
      report.status = "done";
      report.finalAnswer = decision.finalAnswer || decision.thought;
      return report;
    }

    const result = await tools.execTool(decision.tool, decision.tool_input ?? "");

    report.trace.push({
      iteration: report.iterationsUsed,
      phase: decision.phase,
      thought: decision.thought,
      tool: decision.tool,
      tool_input: decision.tool_input ?? "",
      observation: result.output || result.error || "",
      ok: result.ok,
    });

    if (decision.phase === "validation" && result.ok) {
      // Validation passed: the loop's own job is done (mirrors Python).
      report.status = "done";
      report.finalAnswer = `Validation passed: ${result.output.trim().slice(0, 300)}`;
      return report;
    }
  }

  // Iteration maxout: not a failure — the caller (chat/UI) decides whether to continue.
  report.status = "needs_continuation";
  report.finalAnswer =
    `Reached max_iterations (${report.maxIterations}) without finishing. ` +
    "Call continueRun(...) to keep going, or treat this as a stopping point.";
  return report;
}
