// ronin:version 3 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:46:58.243Z | ronin:subtask code-st-f034f3
// Shared ported types for the workflow/orchestrator engines (agentic, brain, procedure).
// TS semantic port of the reference Python workflow packages (agentic_workflow, brain_workflow, procedure_workflow).

/** ReAct phase mirrors the reference agentic_workflow schemas.py Phase. */
export type Phase = "search" | "action" | "validation";

/** Run status mirrors the reference agentic_workflow schemas.py RunStatus. */
export type RunStatus = "running" | "done" | "failed" | "needs_continuation";

/** One Thought -> Action -> Observation cycle (agentic Trace port). */
export interface StepTrace {
  iteration: number;
  phase: Phase | string;
  thought: string;
  tool: string;
  tool_input?: string;
  observation?: string;
  ok?: boolean;
}

/** The accumulated trace plus final verdict (agentic AgentRunReport port). */
export interface AgentRunReport {
  taskDescription: string;
  status: RunStatus;
  iterationsUsed: number;
  maxIterations: number;
  trace: StepTrace[];
  finalAnswer: string;
  runId?: string;
}

/** What the "brain" of one iteration decided to do (agentic AgentDecision port). */
export interface AgentDecision {
  phase: Phase | string;
  thought: string;
  tool: string; // "" / "none" means: stop, task is done
  tool_input?: string;
  done: boolean;
  finalAnswer: string;
}

/**
 * The deterministic loop driver: given run context plus a thin tool facade, decide the single
 * next action. Tests inject a scripted ThinkFn directly (AC-4 smoke-test seam).
 */
export type ThinkFn = (ctx: AgentRunContext, tools: WorkflowToolContext) => Promise<AgentDecision> | AgentDecision;

export interface AgentRunContext {
  taskDescription: string;
  iterationsUsed: number;
  maxIterations: number;
  trace: StepTrace[];
  workspaceRoot: string;
}

/** Thin typed facade over src/tools/toolDispatcher.ts for the agentic loop. */
export interface WorkflowToolContext {
  readonly workspaceRoot: string;
  execTool(name: string, input: unknown): Promise<{ ok: boolean; output: string; error?: string }>;
}

/**
 * Per-role backend config (brain_workflow RoleConfig port). The provider/base_url/api_key
 * collapse away because the transport is always the single injected LlmClient (D2);
 * `model` undefined means "use the injected client's default model".
 */
export interface RoleConfig {
  model?: string;
  temperature?: number; // default 0.2
  responseFormat?: "json_object";
}

export interface RouterCall {
  messages: { role: string; content: string }[];
  role: string;
  model?: string; // explicit model always wins (mirrors Python)
  responseFormat?: boolean | "json_object";
  temperature?: number;
}

/** A procedure step (procedure_workflow Step port, local subset). */
export interface ProcedureStep {
  stepId: string;
  name: string;
  action: "shell" | "llm_call" | "file" | "url" | "theme";
  command: string;
  dependsOn: string[];
  validation?: Record<string, unknown>;
  onFailure: "auto_fix" | "halt" | "skip";
  maxRetries: number;
}

export interface Procedure {
  procedureId: string;
  steps: ProcedureStep[];
}

export interface StepReport {
  stepId: string;
  ok: boolean;
  output: string;
  error?: string;
  attempts: number;
}

export interface ProcedureRunReport {
  procedureId: string;
  status: "completed" | "failed" | "halted";
  stepReports: StepReport[];
  finalOutput: string;
}
