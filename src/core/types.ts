// ronin:version 1 | ronin:task task-4508cb | ronin:updated 2026-08-13T15:28:18.361Z | ronin:subtask code-st-885544
export interface SkillHeader {
  name: string;
  role: string;
  description: string;
  triggers: string[];
  version: string;
  requires_tools: string[];
  composes_with: string[];
}

export interface LoadedSkill {
  header: SkillHeader;
  body: string; // full markdown body (Process/Strategies/Instructions/Planning/Experience)
  path: string;
}

export type Phase = "search" | "action" | "validation";

export interface ReActStep {
  iteration: number;
  phase: Phase;
  thought: string;
  action?: { tool: string; input: unknown };
  observation?: unknown;
  /** Heuristic 0-100 self-healing score for this step (see src/core/stepScorer.ts). Undefined
   *  for steps that don't go through a tool call (e.g. the iteration-limit check entry). */
  score?: number;
}

export interface TelemetryInterface {
  logThought(step: ReActStep): Promise<void>;
  logLlmCall(request: unknown, response: unknown): Promise<void>;
  logError(err: unknown, context?: string): Promise<void>;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[]; // present on assistant messages that requested tool use
  tool_call_id?: string; // present on tool-role messages (the Observation being returned)
  name?: string; // tool name, present on tool-role messages
  reasoning_content?: string; // thinking-mode: must be echoed back on the next turn's assistant message
}

/** OpenAI-compatible function-calling tool schema (DeepSeek uses the same shape). */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string }; // arguments is a JSON string
}

/**
 * A structured clarification request that the LLM can emit when it needs user input
 * to proceed. This is the data model for the "clarification" channel — distinct from
 * normal tool calls and final answers.
 *
 * The LLM emits this via the `clarification_tool` (a dedicated tool call) or as a
 * structured field in the response when the system detects the model is asking for
 * input rather than taking action or providing a final answer.
 *
 * @example
 * ```ts
 * {
 *   question: "Which database should I use for the user profiles?",
 *   context: "The task requires storing user profile data. I found PostgreSQL and SQLite as options.",
 *   options: ["PostgreSQL", "SQLite"]
 * }
 * ```
 */
export interface ClarificationRequest {
  /** The question the LLM needs answered to proceed. */
  question: string;
  /** Context explaining why the question is being asked and what information is available. */
  context: string;
  /** Optional list of predefined options the user can choose from. */
  options?: string[];
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number; // thinking-mode CoT tokens, subset of completionTokens
  cachedTokens?: number; // prompt tokens served from DeepSeek's context cache (cheaper)
}

export interface LlmResponse {
  content: string;
  toolCalls: ToolCall[];
  reasoningContent?: string; // present in thinking mode; must be carried into the next assistant message
  usage?: LlmUsage;
  /** "length" means the completion was cut off by max_tokens, not a natural stop -- any
   *  tool_calls arguments generated in a "length"-truncated response (e.g. a write_edit_tool
   *  content/newStr payload) may be truncated mid-value. See src/core/truncationGuard.ts. */
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | string;
}

export interface LlmClient {
  complete(
    messages: LlmMessage[],
    opts?: { model?: string; temperature?: number; tools?: ToolSchema[]; responseFormat?: "json_object" }
  ): Promise<LlmResponse>;
}

/**
 * Structured result returned when a subagent finishes execution, whether by completing
 * normally or hitting the iteration limit. The parent orchestrator uses this to decide
 * whether to continue, retry, or synthesize a partial report — the subagent never
 * terminates the parent just because it hit its own iteration limit.
 */
export interface SubagentResult {
  /** "completed" = the subagent reached a final answer; "iteration_limit" = it ran out of iterations. */
  status: "completed" | "iteration_limit";
  /** The subagent's final output text (synthesized report if iteration_limit). */
  summary: string;
  /** How many ReAct iterations the subagent executed. */
  iterationCount: number;
  /**
   * When status is "iteration_limit", this contains the subagent's accumulated context:
   * the last assistant thought, tool calls made, and key observations. The parent can
   * use this to decide whether to retry, continue, or synthesize a partial report.
   */
  partialOutput?: {
    /** The last assistant message content (the model's last thought before hitting the limit). */
    lastThought: string;
    /** Summary of tool calls made by the subagent. */
    toolCalls: string[];
    /** Key observations from the subagent's execution. */
    observations: string[];
  };
}

export interface IndexEntry {
  filename: string;
  filepath: string;
  fileVersion: string;
  dumpFile: string;
  /** Byte offset (inclusive) of the file's content within the dump file. */
  startByte: number;
  /** Byte offset (exclusive) of the file's content within the dump file. */
  endByte: number;
}

/**
 * A single health score entry with timestamp and reason.
 * Used to track the agent's self-healing health over time.
 */
export interface ScoreEntry {
  /** ISO 8601 timestamp when this score was recorded. */
  timestamp: string;
  /** Score value 0.0-1.0 (0.0 = failing, 1.0 = perfect). */
  score: number;
  /** Human-readable reason for this score (e.g. "tool call errored", "completed without error"). */
  reason: string;
}

/**
 * Aggregated health score with history and trend direction.
 * Provides a persistent view of the agent's self-healing health state.
 */
export interface HealthScore {
  /** Current rolling average health score (0-100). */
  current: number;
  /** Ordered history of score entries, oldest first. */
  history: ScoreEntry[];
  /** Trend direction based on recent score changes. */
  trend: "up" | "down" | "stable";
}

/**
 * Default health score used when initializing a new ReActMemory instance.
 * Starts at neutral (0.5/100 mapped to 50/100) with no history and stable trend.
 */
export const DEFAULT_HEALTH_SCORE: HealthScore = {
  current: 0.5,
  history: [],
  trend: "stable",
};

/**
 * Persistent memory state for a ReAct agent run.
 * Tracks the agent's health score, which is used to detect when the agent
 * is stuck in a loop or making repeated errors, and to inject self-healing
 * nudges into the context.
 */
export interface ReActMemory {
  /** The agent's self-healing health score with history and trend. */
  healthScore: HealthScore;
}

export interface IndexFile {
  generatedAt: string;
  entries: IndexEntry[];
}

export type SkillDiagnosticCode =
  | "NO_SKILL_MD"
  | "NO_FRONTMATTER"
  | "LEGACY_METADATA"
  | "YAML_ERROR"
  | "INVALID_HEADER"
  | "DIR_NAME_MISMATCH";

/**
 * A diagnostic recorded when a SKILL.md file cannot be parsed or has a
 * recoverable problem (e.g. header name does not match its directory name).
 * Diagnostics are collected on every scan and exposed via
 * SkillRegistry.listDiagnostics(), so parse failures are loud instead of
 * silently skipped.
 */
export interface SkillDiagnostic {
  /** The skill directory this diagnostic was generated from. */
  skillDir: string;
  /** Path to the problematic SKILL.md file (or its directory). */
  path: string;
  /** Machine-readable diagnostic category. */
  code: SkillDiagnosticCode;
  /** Human-readable explanation of the problem. */
  message: string;
  /** Optional extra detail (e.g. YAML error message, list of invalid fields). */
  detail?: string;
}


