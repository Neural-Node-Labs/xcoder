// Typed API client for the xcoder backend. Every function returns the unwrapped `data` from
// the ApiResponse<T> envelope, or throws with the server's `error` message on failure.

// JarvisMood's canonical definition lives in the component, not here — JarvisHologram.tsx is
// deliberately self-contained/portable to other projects, so it owns this type; this API layer
// (xcoder-specific) depends on it, not the other way around.
import type { JarvisMood } from "../components/JarvisHologram";

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

/** Shared by request() and uploadForm(): turns a fetch Response into the unwrapped `data`,
 *  throwing a useful message either way. Pulled out because both had identical copies of this
 *  parsing/error logic, which is exactly the kind of thing that quietly drifts apart when only
 *  one of the two gets updated — as almost happened just adding the 502/503/504 case below. */
async function unwrapResponse<T>(res: Response): Promise<T> {
  let json: ApiResponse<T>;
  try {
    json = await res.json();
  } catch {
    // A non-JSON body almost always means something in front of the api process (a reverse
    // proxy, an ingress, a corporate load balancer) intercepted the request and returned its
    // own plain-HTML error page — the api process itself always returns JSON, even for its own
    // errors (see routes.ts's error handler). 502/503/504 specifically are the "something
    // upstream gave up" family, most commonly a proxy's read-timeout firing on a long-running
    // /chat or /chat/execute call (an agentic run can easily take longer than a proxy's default
    // ~60s) — worth naming explicitly rather than leaving it as an opaque parse failure.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error(
        `The server didn't respond in time (HTTP ${res.status}). This usually means a reverse proxy in front of xcoder gave up waiting on a long-running request (a big task or a slow model can take a while) — the task may still be running server-side. Try again, or check that proxy's read-timeout if this keeps happening.`
      );
    }
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  return unwrapResponse<T>(res);
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body);
const put = <T>(path: string, body?: unknown) => request<T>("PUT", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

/** Like request(), but for multipart/form-data uploads — the generic request() above always
 *  JSON-encodes, which can't carry a real file. Used only by uploadWorkspaceZip() so far. */
async function uploadForm<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  // Deliberately no Content-Type header — the browser sets multipart/form-data with the
  // correct boundary itself. Setting it manually here would omit that boundary and the
  // server would fail to parse the body at all.

  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: form });
  return unwrapResponse<T>(res);
}

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

/** GET /api/v1/auth/me — the answer to "is the token I restored from localStorage still good?".
 *  A 401/403 is the meaningful case; this body is only returned when the session is valid. */
export interface SessionResponse {
  userId: string;
  username: string;
  role: "admin" | "user";
  /** Epoch ms at which this token expires, so the client can log out on schedule rather than
   *  waiting to discover the expiry through a failed request mid-task. */
  expiresAt: number;
}

/** GET /api/v1/models — backs the Chat tab's model picker. Never empty, even when Ollama is
 *  unreachable; `source` says whether the list is live or the compose-pulled fallback. */
export interface ModelListResponse {
  models: string[];
  default: string;
  source: "live" | "fallback" | "config";
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
  /** Optional per-request model override (the Chat tab's picker). Validated server-side
   *  against the models the backend can actually offer — an unknown name is a 400, not a
   *  silent fallback, so the caller always knows which model ran. */
  model?: string;
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
  /** See ExecuteResponse.mood below — same field, same set_mood_tool backing it. */
  mood?: JarvisMood;
}

export interface ExecuteResponse {
  result: string;
  iterations: number;
  limitation?: string;
  continueRequested?: boolean;
  iterationMaxReached?: boolean;
  partialSuccess?: PartialSuccess;
  /** The assistant's current mood for this workspace, as last set (at any point, possibly in
   *  an earlier chat) via set_mood_tool — see src/tools/moodTool.ts server-side. Render with
   *  <JarvisHologram mood={...} /> (components/JarvisHologram.tsx). Always present once any
   *  run has completed for a workspace — a workspace with no mood ever set explicitly gets a
   *  random one on first read rather than a fixed default. */
  mood?: JarvisMood;
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
  authProvider?: "local" | "google";
  email?: string;
}

export interface PlatformToolEntry {
  name: string;
  description: string;
  source: "builtin" | "integration";
}

export interface PlatformIntegrationEntry {
  id: string;
  name: string;
  description: string;
  connected: boolean;
}

export interface CodegraphStatus {
  bundled: boolean;
  running: boolean;
  external: boolean;
  baseUrl?: string;
  startedAt?: string;
  uiAvailable: boolean;
  connecting: boolean;
  connectError?: string;
  configuredUrl?: string;
}

export interface CodegraphSsoSession {
  apiUrl: string;
  token: string;
  user: { id: number; username: string; role: string; api_key: string };
}

export interface GoogleSignInConfig {
  enabled: boolean;
  clientId: string;
}

export interface SecOpsResult {
  level: "ok" | "warn" | "err";
  text: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actorId: string;
  actorUsername: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  modifiedAt?: string;
}

export interface WorkspaceZipUploadResult {
  path: string;
  filesExtracted: number;
  dirsCreated: number;
  bytesWritten: number;
  skipped: string[];
}

export interface LlmConfigSummary {
  provider: string;
  base_url?: string;
  endpoint?: string;
  model: string;
  api_key_env?: string;
  max_tokens: number;
  temperature: number;
  requiresNoAuth: boolean;
}

export interface LlmProviderDefault {
  base_url?: string;
  model: string;
  api_key_env?: string;
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
  googleSignInConfig: () => get<GoogleSignInConfig>("/auth/google/config"),
  loginWithGoogle: (credential: string) => post<LoginResponse>("/auth/google", { credential }),

  /** Cheap "is this token still valid" probe. Used on boot and on a schedule — see
   *  AuthContext. Rejects (and so triggers the unauthorized handler) for a dead session. */
  session: () => get<SessionResponse>("/auth/me"),

  health: () => get<HealthResponse>("/health"),
  engines: () => get<EnginesResponse>("/engines"),
  models: () => get<ModelListResponse>("/models"),

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

  auditLog: (limit = 200) => get<{ entries: AuditLogEntry[] }>(`/audit-log?limit=${limit}`),

  llmKeyStatus: () => get<{ hasKey: boolean }>("/settings/llm-key"),
  setLlmKey: (apiKey: string) => put<{ hasKey: boolean }>("/settings/llm-key", { apiKey }),
  clearLlmKey: () => del<{ hasKey: boolean }>("/settings/llm-key"),

  llmConfig: () => get<LlmConfigSummary>("/settings/llm-config"),
  llmProviders: () => get<{ providers: string[]; defaults: Record<string, LlmProviderDefault>; default: string }>("/settings/llm-providers"),
  updateLlmConfig: (update: Partial<LlmConfigSummary>) => put<LlmConfigSummary>("/settings/llm-config", update),

  workspaceFiles: (projectId: string | undefined, dirPath = ".") =>
    get<{ path: string; entries: WorkspaceFileEntry[] }>(
      `/workspace/files?path=${encodeURIComponent(dirPath)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`
    ),
  workspaceFile: (projectId: string | undefined, filePath: string) =>
    get<{ path: string; content: string; size: number }>(
      `/workspace/file?path=${encodeURIComponent(filePath)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`
    ),
  writeWorkspaceFile: (projectId: string | undefined, filePath: string, content: string) =>
    put<{ path: string; size: number }>("/workspace/file", { projectId, path: filePath, content }),
  createWorkspaceDir: (projectId: string | undefined, dirPath: string) =>
    post<{ path: string }>("/workspace/dir", { projectId, path: dirPath }),
  uploadWorkspaceZip: (projectId: string | undefined, dirPath: string, file: File) => {
    const form = new FormData();
    form.set("file", file);
    if (projectId) form.set("projectId", projectId);
    form.set("path", dirPath);
    return uploadForm<WorkspaceZipUploadResult>("/workspace/upload-zip", form);
  },
  deleteWorkspacePath: (projectId: string | undefined, targetPath: string) =>
    del<{ path: string; deleted: boolean }>(
      `/workspace/file?path=${encodeURIComponent(targetPath)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`
    ),

  users: () => get<User[]>("/users"),
  createUser: (username: string, password: string, role?: "admin" | "user") =>
    post<User>("/users", { username, password, role, authProvider: "local" as const }),
  createGoogleUser: (email: string, role?: "admin" | "user") =>
    post<User>("/users", { email, role, authProvider: "google" as const }),
  updateUser: (id: string, body: { username?: string; role?: "admin" | "user" }) => put<User>(`/users/${id}`, body),
  deleteUser: (id: string) => del<void>(`/users/${id}`),

  platformTools: () => get<{ tools: PlatformToolEntry[] }>("/platform/tools"),
  platformIntegrations: () => get<{ integrations: PlatformIntegrationEntry[] }>("/platform/integrations"),
  connectCodegraph: (baseUrl: string, apiKey: string, defaultProjectId?: string) =>
    post<{ connected: true }>("/platform/integrations/codegraph", { baseUrl, apiKey, defaultProjectId }),
  disconnectCodegraph: () => del<{ connected: false }>("/platform/integrations/codegraph"),
  codegraphStatus: () => get<CodegraphStatus>("/platform/integrations/codegraph/status"),
  startBundledCodegraph: () => post<CodegraphStatus>("/platform/integrations/codegraph/start"),
  stopBundledCodegraph: () => post<CodegraphStatus>("/platform/integrations/codegraph/stop"),
  codegraphSso: () => get<CodegraphSsoSession | null>("/platform/integrations/codegraph/sso"),
  indexCodegraphWorkspace: (projectId?: string, projectName?: string) =>
    post<{ codegraphProjectId: number; codegraphProjectName: string; extractedFiles: number }>(
      "/platform/integrations/codegraph/index-workspace",
      { projectId, projectName }
    ),
  codegraphProjectForName: (name: string) =>
    get<{ project: { id: number; name: string; status: string } | null }>(
      `/platform/integrations/codegraph/project-for-name?name=${encodeURIComponent(name)}`
    ),

  securityOpsAllowlist: () => get<{ allowlist: string[] }>("/security-ops/allowlist"),
  updateSecurityOpsAllowlist: (entries: string[]) => put<{ allowlist: string[] }>("/security-ops/allowlist", { entries }),
  runSecurityOpsTool: (team: "blue" | "red", toolId: string, params: Record<string, string>) =>
    post<SecOpsResult>("/security-ops/run", { team, toolId, params }),

  projects: (allProjects?: boolean) => get<Project[]>(`/projects${allProjects ? "?all=true" : ""}`),
  createProject: (name: string) => post<Project>("/projects", { name }),
  activateProject: (id: string) => post<Project>(`/projects/${id}/activate`),
  deleteProject: (id: string) => del<void>(`/projects/${id}`),
};
