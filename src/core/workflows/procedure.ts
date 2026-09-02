// ronin:version 3 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:46:46.263Z | ronin:subtask code-st-f034f3
// Two-step procedure generation — TS semantic port of
// the reference Python procedure_workflow/orchestrator.py.
//
// Splits generation into two model calls on the same configured role (default "orchestrator"):
//   1. Plan step   - plain text, free-form reasoning, no schema constraint.
//   2. Format step - translate the plan into the strict procedure JSON schema
//                    (responseFormat: "json_object").
import { MultiRoleRouter } from "./router.js";
import { Procedure, ProcedureStep } from "./types.js";

export class ProcedureGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcedureGenerationError";
  }
}

const PLANNING_PROMPT_TEMPLATE = `You are a system architect. Break down the following user task into a logical sequence of technical steps. Keep it strictly to the steps needed to accomplish the goal.

{workspace_note}TASK: {task_description}

Respond with a clear, numbered list of steps.`;

const WORKSPACE_NOTE_TEMPLATE = `The current workspace root is: {workspace_root}
Any file this plan creates, reads, or modifies should default to a path relative to this workspace root unless the task explicitly names a different location.

`;

const SCHEMA_PROMPT_TEMPLATE = `You are an orchestration compiler. Translate the following execution plan into a strict JSON object.
Use ONLY the following actions: {actions}.
{action_notes}

EXECUTION PLAN to translate:
{draft_plan}

Output strictly in this JSON format and nothing else:
{
  "procedure_id": "string",
  "steps": [
    {
      "step_id": "string",
      "name": "string",
      "action": "enum",
      "command": "string",
      "depends_on": [],
      "validation": {},
      "on_failure": "auto_fix|halt|skip",
      "max_retries": 3
    }
  ]
}`;

const DEFAULT_ACTIONS = ["shell execution", "llm call", "file management", "URL Content Reader", "set theme"];

const DEFAULT_ACTION_NOTES =
  "'set theme' takes a short mood/context description as its command (e.g. \"celebratory, the deploy just succeeded\") and lets the model pick a matching value -- only include a 'set theme' step if the task explicitly asks for mood-based classification.";

/** Map the Python/conversational action names onto the TS ProcedureStep.action union. */
function normalizeAction(action: string): ProcedureStep["action"] {
  const a = String(action || "").trim().toLowerCase();
  if (a === "shell execution" || a === "shell" || a === "run_command" || a === "command") return "shell";
  if (a === "llm call" || a === "llm_call" || a === "llm") return "llm_call";
  if (a === "file management" || a === "file" || a === "filesystem") return "file";
  if (a === "url content reader" || a === "url" || a === "fetch" || a === "http") return "url";
  if (a === "set theme" || a === "theme") return "theme";
  // Be lenient: coerce unknown actions to shell execution rather than failing the whole
  // procedure at parse time (mirrors procedure_workflow Step.from_dict).
  return "shell";
}

function normalizeOnFailure(value: unknown): ProcedureStep["onFailure"] {
  const v = String(value || "auto_fix").trim().toLowerCase();
  if (v === "halt") return "halt";
  if (v === "skip" || v === "skipped") return "skip";
  return "auto_fix";
}

/** Parse the format-step JSON into a validated Procedure (mirrors Procedure.from_dict). */
export function parseProcedure(rawJson: string): Procedure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new ProcedureGenerationError(
      `Orchestrator returned invalid JSON for procedure schema: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new ProcedureGenerationError("Orchestrator returned non-object JSON for procedure schema.");
  }

  const dict = parsed as Record<string, unknown>;
  const stepsRaw = Array.isArray(dict.steps) ? dict.steps : [];

  const steps: ProcedureStep[] = stepsRaw.map((s) => {
    const step = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    const dependsRaw = step.depends_on ?? step.dependsOn ?? [];
    const dependsOn = Array.isArray(dependsRaw) ? dependsRaw.map((d: unknown) => String(d)) : [];
    return {
      stepId: String(step.step_id ?? step.stepId ?? Math.random().toString(36).slice(2, 10)),
      name: String(step.name ?? "unnamed step"),
      action: normalizeAction(String(step.action ?? "shell execution")),
      command: String(step.command ?? step.command_intent ?? ""),
      dependsOn,
      validation: step.validation && typeof step.validation === "object" ? (step.validation as Record<string, unknown>) : {},
      onFailure: normalizeOnFailure(step.on_failure ?? step.onFailure),
      maxRetries: Math.max(1, Number(step.max_retries ?? 3) || 3),
    };
  });

  return {
    procedureId: String(dict.procedure_id ?? dict.procedureId ?? Math.random().toString(36).slice(2)),
    steps,
  };
}

export interface GenerateProcedureOptions {
  role?: string;
  actions?: string[];
  actionNotes?: string;
  workspaceRoot?: string;
}

/**
 * Two-step generation: plain-text plan, then strict-JSON schema translation.
 * Throws ProcedureGenerationError on LLM failure or invalid JSON.
 */
export async function generateProcedure(
  taskDescription: string,
  router: MultiRoleRouter,
  opts: GenerateProcedureOptions = {}
): Promise<Procedure> {
  const role = opts.role ?? "orchestrator";
  const workspaceRoot = opts.workspaceRoot;

  const workspaceNote = workspaceRoot ? WORKSPACE_NOTE_TEMPLATE.replace("{workspace_root}", workspaceRoot) : "";
  const planPrompt = PLANNING_PROMPT_TEMPLATE.replace("{workspace_note}", workspaceNote).replace(
    "{task_description}",
    taskDescription
  );

  let planText: string;
  try {
    planText = await router.chat({
      messages: [{ role: "user", content: planPrompt }],
      role,
    });
  } catch (err) {
    throw new ProcedureGenerationError(
      `Planning step failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const actions = opts.actions ?? DEFAULT_ACTIONS;
  const actionNotes = opts.actionNotes ?? DEFAULT_ACTION_NOTES;
  const schemaPrompt = SCHEMA_PROMPT_TEMPLATE
    .replace("{actions}", actions.map((a) => `'${a}'`).join(", "))
    .replace("{action_notes}", actionNotes)
    .replace("{draft_plan}", planText);

  let rawJson: string;
  try {
    rawJson = await router.chat({
      messages: [{ role: "user", content: schemaPrompt }],
      role,
      responseFormat: "json_object",
    });
  } catch (err) {
    throw new ProcedureGenerationError(
      `Schema generation call failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const procedure = parseProcedure(rawJson);
  if (procedure.steps.length === 0) {
    throw new ProcedureGenerationError("Orchestrator returned a procedure with no steps.");
  }
  return procedure;
}
