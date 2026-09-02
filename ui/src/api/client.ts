// Typed API client for the xcoder backend. Every function returns the unwrapped `data` from
// the ApiResponse<T> envelope, or throws with the server's `error` message on failure.

const BASE = "/api/v1";

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

let authToken: string | null = localStorage.getItem("xcoder_token");

export function setAuthToken(token: string | null) {
  authToken = token;
  if (token) localStorage.setItem("xcoder_token", token);
  else localStorage.removeItem("xcoder_token");
}

export function getAuthToken() {
  return authToken;
}

// The server's token store is in-memory (see src/api/auth.ts) — it's wiped on every API
// process restart. A token saved in localStorage from a previous server run then comes back
// as a 401 (missing/malformed header) or a specific-message 403 ("Invalid or expired API
// token"). Without this, that surfaces as a dead-end network error with no way out short of
// manually clearing localStorage. AuthContext registers a handler here that force-clears the
// stale session and drops the user back to the login screen instead.
const AUTH_INVALID_MESSAGES = new Set([
  "Invalid or expired API token",
  "Missing Authorization header",
  "Authorization header must be: Bearer <token>",
]);

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let json: ApiResponse<T>;
  try {
    json = await res.json();
  } catch {
    throw new Error(`Server returned a non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok || !json.success) {
    // Only auth-store-level failures trigger a forced logout — NOT requireAdmin's 403
    // ("Admin privileges required"), which means the token is fine but the role isn't.
    if (res.status === 401 || (res.status === 403 && AUTH_INVALID_MESSAGES.has(json.error ?? ""))) {
      onUnauthorized?.();
    }
    throw new Error(json.error || `Request failed (HTTP ${res.status})`);
  }
  return json.data as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body);
const put = <T>(path: string, body?: unknown) => request<T>("PUT", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

// ─── Types (mirrors src/api/types.ts) ──────────────────────────────────────────────

export interface LoginResponse {
  token: string;
  userId: string;
  username: string;
  role: "admin" | "user";
}

export interface HealthResponse {
  status: "ok";
  version: string;
  uptime: number;
  mockLlm: boolean;
}

export interface EnginesResponse {
  engines: string[];
  default: string;
}

export interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface PartialSuccess {
  toolCalls: { name: string; args: string; result: string }[];
  filesModified: string[];
  filesRead: string[];
  commandsRun: string[];
  lastThought: string;
  iterationCount: number;
  restartCount: number;
}

export interface ChatRequest {
  task: string;
  planMode?: "auto" | "always" | "never";
  fullContextToken?: boolean;
  projectId?: string;
  maxIterations?: number;
  isolatedWorkspace?: boolean;
  continueOnLimit?: boolean;
  phasePlanning?: boolean;
  auto?: boolean;
  engine?: string;
}

export interface ChatResponse {
  result: string;
  iterations: number;
  plan?: string;
  sessionId?: string;
  usage?: UsageSummary;
  healthScore?: number;
  limitation?: string;
  continueRequested?: boolean;
  iterationMaxReached?: boolean;
  partialSuccess?: PartialSuccess;
}

export interface ExecuteResponse {
  result: string;
  iterations: number;
  limitation?: string;
  continueRequested?: boolean;
  iterationMaxReached?: boolean;
  partialSuccess?: PartialSuccess;
}

export interface SkillListEntry {
  name: string;
  role: string;
  description: string;
  triggers: string[];
  composes_with: string[];
}

export interface TaskHistoryEntry {
  id: string;
  task: string;
  summary: string;
  timestamp: string;
  iterations: number;
  totalTokens: number | null;
}

export interface WbsEntry {
  id: string;
  taskId: string;
  taskDescription: string;
  phaseNumber: number;
  phaseTitle: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  createdAt: string;
  updatedAt: string;
}

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

export interface Project {
  id: string;
  userId: string;
  name: string;
  path: string;
  active: boolean;
  includeInLlm: boolean;
  createdAt: string;
}

export interface User {
  id: string;
  username: string;
  role: "admin" | "user";
  createdAt: string;
}

export interface TelemetryEntry {
  timestamp?: string;
  data?: unknown;
  raw?: unknown;
}

// ─── Auth ───────────────────────────────────────────────────────────────────────

export const api = {
  login: (username: string, password: string) => post<LoginResponse>("/login", { username, password }),
  logout: () => post<void>("/logout"),
  register: (username: string, password: string) => post<LoginResponse>("/register", { username, password }),
  userCount: () => get<{ count: number }>("/users/count"),

  health: () => get<HealthResponse>("/health"),
  engines: () => get<EnginesResponse>("/engines"),

  chat: (body: ChatRequest) => post<ChatResponse>("/chat", body),
  plan: (body: ChatRequest) => post<{ sessionId: string; plan: string; task: string; planMode: string }>("/chat/plan", body),
  execute: (sessionId: string) => post<ExecuteResponse>("/chat/execute", { sessionId }),

  skills: () => get<SkillListEntry[]>("/skills"),

  taskHistory: (limit = 20, projectId?: string) =>
    get<{ tasks: TaskHistoryEntry[] }>(`/task-history?limit=${limit}${projectId ? `&projectId=${projectId}` : ""}`),
  taskLogs: (taskId: string) => get<unknown>(`/task-history/${taskId}/logs`),

  phaseReports: (taskId: string) => get<{ reports: PhaseReportEntry[] }>(`/phase-reports?taskId=${encodeURIComponent(taskId)}`),
  phaseReport: (id: string) => get<PhaseReportEntry>(`/phase-reports/${id}`),

  wbs: (taskId: string) => get<{ entries: WbsEntry[] }>(`/wbs?taskId=${encodeURIComponent(taskId)}`),
  updateWbsStatus: (id: string, status: WbsEntry["status"]) => put<{ id: string; status: string }>(`/wbs/${id}/status`, { status }),

  telemetry: (log: "thinking" | "llm" | "sys", limit = 50) =>
    get<{ logFile: string; entries: TelemetryEntry[] }>(`/telemetry?log=${log}&limit=${limit}`),

  llmKeyStatus: () => get<{ hasKey: boolean }>("/settings/llm-key"),
  setLlmKey: (apiKey: string) => put<{ hasKey: boolean }>("/settings/llm-key", { apiKey }),
  clearLlmKey: () => del<{ hasKey: boolean }>("/settings/llm-key"),

  users: () => get<User[]>("/users"),
  createUser: (username: string, password: string, role?: "admin" | "user") =>
    post<User>("/users", { username, password, role }),
  updateUser: (id: string, body: { username?: string; role?: "admin" | "user" }) => put<User>(`/users/${id}`, body),
  deleteUser: (id: string) => del<void>(`/users/${id}`),

  projects: (allProjects?: boolean) => get<Project[]>(`/projects${allProjects ? "?all=true" : ""}`),
  createProject: (name: string) => post<Project>("/projects", { name }),
  activateProject: (id: string) => post<Project>(`/projects/${id}/activate`),
  deleteProject: (id: string) => del<void>(`/projects/${id}`),
};
