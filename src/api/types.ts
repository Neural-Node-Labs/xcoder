/**
 * API-specific types for the devnull HTTP API.
 */

/** Standard API envelope for all responses. */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** POST /api/v1/chat request body. */
export interface ChatRequest {
  task: string;
  /** Optional: force plan mode on/off for this request. */
  planMode?: "auto" | "always" | "never";
  /** Optional: keep every historical copy of read_tool file snapshots in context instead of
   *  collapsing stale ones (lean-token compaction is the default). Default: false. */
  fullContextToken?: boolean;
  /** Optional: which project to run against. Defaults to the currently active project; falls
   *  back to the server's own cwd if no projects exist at all. */
  projectId?: string;
  /** Optional: cap on ReAct loop iterations before asking whether to continue. */
  maxIterations?: number;
  /** Optional: run tool operations against an isolated workspace-agent/ copy instead of the
   *  project's live files. Default: false. */
  isolatedWorkspace?: boolean;
  /** Optional: when true, the orchestrator auto-continues past the iteration limit instead of
   *  stopping. Used by the UI's "Continue" button when a limitation message is shown. */
  continueOnLimit?: boolean;
  /** Optional: enable phase-based planning. When true, the task is divided into multiple phases
   *  each with isolated ReAct memory to reduce token footprint. Default: false. */
  phasePlanning?: boolean;
  /**
   * Optional: fully autonomous mode — automatically answers "yes" to ALL interactive prompts
   * (plan approval, phase plan approval, iteration limit continuation, subagent continuation).
   * The LLM drives end-to-end without any human intervention. Use this for CI/CD, automated
   * testing, or any scenario where zero human input is desired. Default: false.
   */
  auto?: boolean;
  /** Optional: which registered engine to run this task through (e.g. "sdlc", "react", "lean",
   *  "swarm"). Defaults to DEFAULT_ENGINE ("sdlc") when omitted. Invalid/unknown names fall
   *  back to the default rather than erroring, so a stale UI selection never breaks a run. */
  engine?: string;
}

/** POST /api/v1/chat response data. */
export interface ChatResponse {
  result: string;
  /** Number of iterations the orchestrator ran. */
  iterations: number;
  /** The generated plan, if plan mode was active. The UI can display this for user approval. */
  plan?: string;
  /** Session ID for the plan, if plan mode was active. The UI can use this with /chat/execute. */
  sessionId?: string;
  /** Cumulative token usage for this run (includes subagent usage). */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; reasoningTokens?: number };
  /** Rolling self-healing health score (0-100) at the end of the run. */
  healthScore?: number;
  /** Present when the run ended without a clean success — surfaced distinctly from a generic
   *  transport error so the UI can show *why* it stopped (iteration limit, validator exhausted,
   *  plan rejected, etc.) rather than just "something went wrong". */
  limitation?: string;
  /** When true, the server is explicitly requesting user input to continue (e.g., iteration
   *  limit reached). The UI should highlight the "Continue" button in red to draw attention. */
  continueRequested?: boolean;
  /** When true, the run stopped because the iteration limit was reached. The UI should
   *  highlight the limitation message in red to distinguish it from other limitation types. */
  iterationMaxReached?: boolean;
  /**
   * When present, a subagent hit its iteration limit and the preserved context is included
   * so the UI can re-send it with continueOnLimit: true to resume the subagent without
   * losing progress. Contains the subagent's last thought, tool calls, and observations.
   */
  subagentContext?: {
    /** The subagent's last assistant message content before hitting the limit. */
    lastThought: string;
    /** Summary of tool calls made by the subagent. */
    toolCalls: string[];
    /** Key observations from the subagent's execution. */
    observations: string[];
    /** How many iterations the subagent completed before hitting the limit. */
    iterationCount: number;
  };
  /**
   * When present, the orchestrator hit the iteration limit and captured partial-success
   * context — what was accomplished before stopping. Contains the last N tool calls,
   * files modified, files read, commands run, and the last thought. The UI can surface
   * this information to show the user what progress was made.
   */
  partialSuccess?: {
    /** The last N tool calls made before the iteration limit was hit. */
    toolCalls: { name: string; args: string; result: string }[];
    /** Files that were modified during the run (write_edit_tool calls). */
    filesModified: string[];
    /** Files that were read during the run (read_tool calls). */
    filesRead: string[];
    /** Commands that were executed (run_command_tool calls). */
    commandsRun: string[];
    /** The last assistant thought before hitting the limit. */
    lastThought: string;
    /** How many iterations were completed before hitting the limit. */
    iterationCount: number;
    /** How many restarts occurred. */
    restartCount: number;
  };
}

/** POST /api/v1/chat/plan request body. */
export interface PlanRequest {
  task: string;
  planMode?: "auto" | "always" | "never";
  fullContextToken?: boolean;
  projectId?: string;
  maxIterations?: number;
  isolatedWorkspace?: boolean;
  continueOnLimit?: boolean;
  phasePlanning?: boolean;
  engine?: string;
}
export interface PlanResponse {
  sessionId: string;
  plan: string;
  task: string;
  planMode: "auto" | "always" | "never";
}

/** POST /api/v1/chat/execute request body. */
export interface ExecuteRequest {
  sessionId: string;
}

/** POST /api/v1/chat/execute response data. */
export interface ExecuteResponse {
  result: string;
  iterations: number;
  limitation?: string;
  continueRequested?: boolean;
  iterationMaxReached?: boolean;
  /**
   * When present, the orchestrator hit the iteration limit and captured partial-success
   * context — what was accomplished before stopping. Contains the last N tool calls,
   * files modified, files read, commands run, and the last thought. The UI can surface
   * this information to show the user what progress was made.
   */
  partialSuccess?: {
    /** The last N tool calls made before the iteration limit was hit. */
    toolCalls: { name: string; args: string; result: string }[];
    /** Files that were modified during the run (write_edit_tool calls). */
    filesModified: string[];
    /** Files that were read during the run (read_tool calls). */
    filesRead: string[];
    /** Commands that were executed (run_command_tool calls). */
    commandsRun: string[];
    /** The last assistant thought before hitting the limit. */
    lastThought: string;
    /** How many iterations were completed before hitting the limit. */
    iterationCount: number;
    /** How many restarts occurred. */
    restartCount: number;
  };
}

/** GET /api/v1/health response data. */
export interface HealthResponse {
  status: "ok";
  version: string;
  uptime: number;
  /** True when this server is running with DEVNULL_MOCK_LLM set — every /chat and /chat/plan
   *  call is answered by AutoMockLlmClient, not a real provider. See src/llm/mockClient.ts. */
  mockLlm: boolean;
}

/** GET /api/v1/engines response data. */
export interface EnginesResponse {
  engines: string[];
  default: string;
}

/** GET /api/v1/telemetry query params. */
export interface TelemetryQuery {
  /** Filter by log file: "thinking", "llm", "sys". Default: "thinking". */
  log?: "thinking" | "llm" | "sys";
  /** Number of most recent entries to return. Default: 50. */
  limit?: number;
}

/** GET /api/v1/telemetry response data. */
export interface TelemetryResponse {
  logFile: string;
  entries: unknown[];
}

/** GET /api/v1/skills response data. */
export interface SkillListEntry {
  name: string;
  role: string;
  description: string;
  triggers: string[];
  composes_with: string[];
}

/** A user in the system. */
export interface User {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt: string;
}

/** POST /api/v1/users request body. */
export interface CreateUserRequest {
  username: string;
  password: string;
  role?: "admin" | "user";
}

/** PUT /api/v1/users/:id request body. */
export interface UpdateUserRequest {
  username?: string;
  role?: "admin" | "user";
}

/** POST /api/v1/login request body. */
export interface LoginRequest {
  username: string;
  password: string;
}

/** POST /api/v1/login response data. */
export interface LoginResponse {
  token: string;
  userId: string;
  username: string;
  role: "admin" | "user";
}

// ─── Phase Report Types ──────────────────────────────────────────────────

/** A phase report entry returned by the API. */
export interface PhaseReportEntry {
  id: string;
  taskId: string;
  phaseNumber: number;
  phaseTitle: string;
  content: string;
  tokens: number;
  iterations: number;
  createdAt: string;
}

/** GET /api/v1/phase-reports query params. */
export interface PhaseReportsQuery {
  taskId?: string;
}

/** GET /api/v1/phase-reports response data. */
export interface PhaseReportsResponse {
  reports: PhaseReportEntry[];
}

// ─── WBS Types ───────────────────────────────────────────────────────────

/** A WBS entry returned by the API. */
export interface WbsEntryResponse {
  id: string;
  taskId: string;
  taskDescription: string;
  phaseNumber: number;
  phaseTitle: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  createdAt: string;
  updatedAt: string;
}

/** GET /api/v1/wbs query params. */
export interface WbsQuery {
  taskId?: string;
}

/** GET /api/v1/wbs response data. */
export interface WbsResponse {
  entries: WbsEntryResponse[];
}

/** PUT /api/v1/wbs/:id/status request body. */
export interface UpdateWbsStatusRequest {
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
}

// ─── Task History Types ────────────────────────────────────────────────────

/** A task history entry returned by the API. */
export interface TaskHistoryEntryResponse {
  id: string;
  task: string;
  summary: string;
  timestamp: string;
  iterations: number;
  totalTokens: number | null;
}

/** GET /api/v1/task-history query params. */
export interface TaskHistoryQuery {
  limit?: number;
}

/** GET /api/v1/task-history response data. */
export interface TaskHistoryListResponse {
  tasks: TaskHistoryEntryResponse[];
}

/** GET /api/v1/task-history/:id response data. */
export interface TaskHistoryDetailResponse {
  task: TaskHistoryEntryResponse;
}


