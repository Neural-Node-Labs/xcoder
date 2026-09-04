import { Router, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { OrchestratorOptions } from "../core/orchestrator.js";
import { createEngine, DEFAULT_ENGINE, listEngines } from "../core/engine/EngineRegistry.js";
import { createLlmClient } from "../llm/deepseekClient.js";
import { FileTelemetry } from "../telemetry/logger.js";
import { loadLlmConfig } from "../config/loadConfig.js";
import { resolveLogsDir } from "../config/paths.js";
import { SkillRegistry } from "../core/skillRegistry.js";
import { authMiddleware, requireAdmin, verifyLogin, findGoogleUser, generateToken, revokeToken, setUserStore, getUserStore, hashPassword, isLegacyHash, checkRateLimit, checkTaskRateLimit, StoredUser } from "./auth.js";
import { verifyGoogleIdToken, isGoogleSignInConfigured, getGoogleClientId } from "./googleAuth.js";
import { loadPersistedUsers, persistUsers, nextUserIdAfter } from "./userStorePersistence.js";
import { registerProjectRoutes } from "./projectRoutes.js";
import { registerPlanRoutes } from "./planRoutes.js";
import { listProjects, getProject, getActiveProject } from "./projectStore.js";
import { hasStoredApiKey, setStoredApiKey, clearStoredApiKey, applyStoredApiKey } from "./llmKeyStore.js";
import { getCodegraphConnection, isCodegraphConnected, setCodegraphConnection, clearCodegraphConnection } from "./codegraphKeyStore.js";
import { getStatus as getCodegraphStatus, startBundledCodegraph, stopBundledCodegraph, getSsoSession } from "./codegraphProcess.js";
import { TOOL_SCHEMAS } from "../tools/toolSchemas.js";
import { readTaskHistory } from "../core/taskHistory.js";
import { PhaseReportStore } from "./phaseReportStore.js";
import { WbsStore } from "./wbsStore.js";
import { TaskHistoryStore } from "./taskHistoryStore.js";
import type {
  ApiResponse,
  ChatRequest,
  ChatResponse,
  PlanRequest,
  PlanResponse,
  ExecuteRequest,
  ExecuteResponse,
  CreateUserRequest,
  HealthResponse,
  EnginesResponse,
  LoginRequest,
  LoginResponse,
  TelemetryQuery,
  TelemetryResponse,
  SkillListEntry,
  UpdateUserRequest,
  User,
  TaskHistoryEntryResponse,
  TaskHistoryListResponse,
  TaskHistoryDetailResponse,
  GoogleLoginRequest,
  PlatformToolEntry,
  PlatformToolsResponse,
  PlatformIntegrationEntry,
  PlatformIntegrationsResponse,
  ConnectCodegraphRequest,
} from "./types.js";

const pkg = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
);

export function createRouter(): Router {
  const router = Router();
  registerProjectRoutes(router);
  registerPlanRoutes(router);

  /**
   * Resolves which directory a task should run against: the explicitly requested project, else
   * the currently active project, else the server's own cwd as a legacy fallback for anyone
   * running xcoder without ever having added a project. Previously this was just hardcoded to
   * process.cwd() everywhere, silently ignoring whatever the user had picked in the Projects UI.
   */
  /**
   * Resolves which workspace directory a request should operate against, always scoped to
   * the authenticated caller: an explicit `projectId` must belong to them (or they must be an
   * admin), and the "no projectId given" fallback is THEIR OWN active project, never anyone
   * else's — there is no single global active project anymore, each user has their own.
   */
  /** The authenticated caller, attached by authMiddleware before any route in this router
   *  runs. See projectRoutes.ts's identical helper for why this is read from the verified
   *  token rather than any client-supplied field. */
  function authedUser(req: Request): { userId: string; isAdmin: boolean } {
    const user = (req as { user?: { userId: string; role: "admin" | "user" } }).user;
    return { userId: user?.userId ?? "", isAdmin: user?.role === "admin" };
  }

  function resolveProjectCwd(userId: string, isAdmin: boolean, projectId?: string): { cwd: string; error?: string } {
    if (projectId) {
      const project = getProject(projectId, userId, { allowAnyOwner: isAdmin });
      if (!project) return { cwd: process.cwd(), error: `Project not found: ${projectId}` };
      return { cwd: project.path };
    }
    const active = getActiveProject(userId);
    if (active) return { cwd: active.path };
    return { cwd: process.cwd() };
  }

  /**
   * Resolves the requested engine name against the registry, falling back to DEFAULT_ENGINE
   * ("sdlc") for anything unset or unrecognized. Deliberately never errors on a bad value —
   * a stale UI dropdown or an outdated client shouldn't be able to break a run; it should just
   * silently get the platform's default engine instead.
   */
  function resolveEngineName(requested?: string): string {
    if (requested && listEngines().includes(requested)) return requested;
    return DEFAULT_ENGINE;
  }

  // ─── Login (no auth required) ──────────────────────────────────────────
  router.post("/login", (req: Request, res: Response) => {
    const { username, password } = req.body as LoginRequest;

    if (!username || typeof username !== "string" || username.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'username' field" };
      res.status(400).json(body);
      return;
    }

    if (!password || typeof password !== "string" || password.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'password' field" };
      res.status(400).json(body);
      return;
    }

    const rateLimitKey = `${req.ip}:${username.trim().toLowerCase()}`;
    const { limited, retryAfterMs } = checkRateLimit(rateLimitKey);
    if (limited) {
      const body: ApiResponse = {
        success: false,
        error: `Too many login attempts. Try again in ${Math.ceil((retryAfterMs ?? 0) / 1000)}s.`,
      };
      res.status(429).json(body);
      return;
    }

    const verifiedUser = verifyLogin(username.trim(), password);
    if (!verifiedUser) {
      const body: ApiResponse = { success: false, error: "Invalid username or password" };
      res.status(401).json(body);
      return;
    }

    // Opportunistically upgrade any pre-scrypt (legacy SHA-256) hash now that we have the
    // plaintext password in hand, so stored hashes migrate to scrypt over time without a
    // separate migration step or forcing a password reset.
    if (isLegacyHash(verifiedUser.passwordHash)) {
      verifiedUser.passwordHash = hashPassword(password);
    }

    const token = generateToken(verifiedUser.id, verifiedUser.username, verifiedUser.role);
    const data: LoginResponse = { token, userId: verifiedUser.id, username: verifiedUser.username, role: verifiedUser.role };
    const body: ApiResponse<LoginResponse> = { success: true, data };
    res.json(body);
  });

  // ─── Logout (no auth required — we read the token from the header) ──────
  router.post("/logout", (req: Request, res: Response) => {
    const header = req.headers.authorization;
    if (!header) {
      const body: ApiResponse = { success: true, data: { message: "No token to revoke" } };
      res.json(body);
      return;
    }

    const parts = header.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer") {
      const revoked = revokeToken(parts[1]);
      const body: ApiResponse = {
        success: true,
        data: { message: revoked ? "Token revoked" : "Token not found or already revoked" },
      };
      res.json(body);
      return;
    }

    const body: ApiResponse = { success: true, data: { message: "No valid token to revoke" } };
    res.json(body);
  });

  // ─── Health (no auth required — used by Docker healthcheck) ────────────
  router.get("/health", (_req: Request, res: Response) => {
    const data: HealthResponse = {
      status: "ok",
      version: pkg.version ?? "0.1.0",
      uptime: process.uptime(),
      mockLlm: /^(1|true)$/i.test(process.env.XCODER_MOCK_LLM ?? ""),
    };
    const body: ApiResponse<HealthResponse> = { success: true, data };
    res.json(body);
  });

  // ─── Engine registry ────────────────────────────────────────────────────
  // Lets the UI populate an engine picker without hardcoding engine names, and confirms
  // which one is the default (currently "sdlc") without the frontend needing to know that
  // out of band.
  router.get("/engines", (_req: Request, res: Response) => {
    const data: EnginesResponse = { engines: listEngines(), default: DEFAULT_ENGINE };
    const body: ApiResponse<EnginesResponse> = { success: true, data };
    res.json(body);
  });

  // ─── Google sign-in config (no auth required — the login screen needs this before the
  //     user has any token, to decide whether to render the "Sign in with Google" button
  //     and which client id to initialize Google Identity Services with). Never exposes a
  //     secret: the OAuth "Web application" client id is intentionally public. ────────────
  router.get("/auth/google/config", (_req: Request, res: Response) => {
    const body: ApiResponse<{ enabled: boolean; clientId: string }> = {
      success: true,
      data: { enabled: isGoogleSignInConfigured(), clientId: isGoogleSignInConfigured() ? getGoogleClientId() : "" },
    };
    res.json(body);
  });

  // All other routes require auth
  router.use(authMiddleware);

  // ─── Chat / Task Execution ─────────────────────────────────────────────
  router.post("/chat", async (req: Request, res: Response) => {
    const { task, planMode, fullContextToken, projectId, maxIterations, isolatedWorkspace, continueOnLimit, phasePlanning, engine } = req.body as ChatRequest;

    if (!task || typeof task !== "string" || task.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'task' field" };
      res.status(400).json(body);
      return;
    }

    const { userId, isAdmin } = authedUser(req);

    const { limited, retryAfterMs } = checkTaskRateLimit(userId);
    if (limited) {
      res.status(429).json({
        success: false,
        error: `Task submission rate limit exceeded. Try again in ${Math.ceil((retryAfterMs ?? 0) / 1000)}s.`,
      } as ApiResponse);
      return;
    }
    const { cwd, error: projectError } = resolveProjectCwd(userId, isAdmin, projectId);
    if (projectError) {
      res.status(404).json({ success: false, error: projectError } as ApiResponse);
      return;
    }
    const telemetry = new FileTelemetry(cwd);
    const llmConfig = loadLlmConfig();
    applyStoredApiKey(llmConfig);
    const llm = createLlmClient(llmConfig, telemetry);

    // In API context, disable interactive prompts (no TTY available). Plan mode auto-approves
    // and the plan is returned in the response. Iteration-limit hits stop and report rather
    // than auto-continuing forever (the CLI's default) — an API caller has no way to answer an
    // interactive "continue?" prompt, so silently looping is the wrong default here.
    // When continueOnLimit is true (UI's "Continue" button), the orchestrator auto-continues
    // past the iteration limit instead of stopping.
    //
    // When the iteration limit is hit and the caller declines to continue, the handler:
    // 1. Calls extractPartialSuccessContext() to capture what was accomplished
    // 2. Calls synthesizeReport() to generate a partial-completion summary
    // 3. Returns false to stop the orchestrator
    // The partial-success context is then retrieved via getPartialSuccess() and included
    // in the API response alongside the limitation field.
    const opts: OrchestratorOptions = {
      cwd,
      interactive: false,
      onIterationLimitReached: async (_taskDescription: string, _iterationsSoFar: number) => {
        // When continueOnLimit is true, auto-continue without capturing partial context
        if (continueOnLimit) return true;
        // Return false to stop — the orchestrator will call synthesizeReport() internally
        // and set lastOutcome to "partial_success". We'll retrieve the partial-success
        // context from getPartialSuccess() after run() completes.
        return false;
      },
    };
    if (planMode) opts.planMode = planMode;
    if (fullContextToken) opts.fullContextToken = true;
    if (maxIterations) opts.maxIterations = maxIterations;
    if (isolatedWorkspace) opts.isolatedWorkspace = true;
    if (continueOnLimit) opts.continueOnLimit = true;
    // Map API's phasePlanning (true = enable) to orchestrator's singlePhase (false = enable)
    if (phasePlanning === false) opts.singlePhase = true;

    const orchestrator = createEngine(resolveEngineName(engine), { llm, telemetry, options: { ...opts, persistToDb: true } });

    try {
      // If plan mode is active, generate the plan first and return it in the response
      // so the UI can display it. The UI should use /chat/plan + /chat/execute for
      // the two-phase approval flow, but /chat also supports it for backward compatibility.
      const skills = orchestrator.selectSkills(task.trim());
      const shouldPlan =
        planMode === "always" || (planMode !== "never" && skills.length >= 2);

      let plan: string | undefined;
      let sessionId: string | undefined;

      if (shouldPlan) {
        plan = await orchestrator.generatePlan(task.trim());
        sessionId = crypto.randomUUID();
        planSessions.set(sessionId, {
          userId,
          task: task.trim(),
          plan,
          planMode: planMode ?? "always",
          fullContextToken: fullContextToken ?? false,
          projectId,
          maxIterations,
          isolatedWorkspace: isolatedWorkspace ?? false,
          continueOnLimit: continueOnLimit ?? false,
          phasePlanning: phasePlanning ?? false,
          engine: resolveEngineName(engine),
          createdAt: Date.now(),
        });
      }

      const result = await orchestrator.run(task.trim());
      const outcome = orchestrator.getLastOutcome();
      const data: ChatResponse = {
        result,
        iterations: 0,
        usage: orchestrator.getCumulativeUsage(),
        healthScore: orchestrator.getHealthScore(),
      };
      if (plan) data.plan = plan;
      if (sessionId) data.sessionId = sessionId;
      if (outcome !== "completed") {
        data.limitation =
          outcome === "iteration_limit" || outcome === "partial_success"
            ? "The task did not finish within the iteration limit."
            : "The plan was not approved, so no changes were made.";
        if (outcome === "iteration_limit" || outcome === "partial_success") {
          data.iterationMaxReached = true;
          data.continueRequested = true;
        }
      }
      // Include partial-success context when the orchestrator captured it
      const partialSuccess = orchestrator.getPartialSuccess();
      if (partialSuccess) {
        data.partialSuccess = partialSuccess;
      }
      // Include subagent limit context when a subagent hit its iteration limit
      const subagentContext = orchestrator.getSubagentLimitContext();
      if (subagentContext) {
        data.subagentContext = subagentContext;
      }
      // Persist phase report to PostgreSQL when the iteration limit was hit during
      // phase planning and we have partial-success context. This ensures the phase
      // report store has a record of what was accomplished even when the task didn't
      // complete normally. The store gracefully falls back if the DB is unreachable.
      if (partialSuccess && phasePlanning !== false) {
        const phaseReportStore = new PhaseReportStore();
        await phaseReportStore.save({
          taskId: crypto.randomUUID(),
          phaseNumber: 1,
          phaseTitle: "Partial Completion",
          content: result,
          tokens: orchestrator.getCumulativeUsage()?.totalTokens ?? 0,
          iterations: partialSuccess.iterationCount,
        }).catch(() => {
          // PhaseReportStore already logs warnings on failure; no need to re-log
        });
      }
      const body: ApiResponse<ChatResponse> = { success: true, data };
      res.json(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await telemetry.logError(err, "api/chat");
      const body: ApiResponse = { success: false, error: message };
      res.status(500).json(body);
    }
  });

  // ─── Plan Session Store ────────────────────────────────────────────────
  // In-memory store for plan sessions. Each session holds the task, plan text,
  // and orchestrator options needed to execute the plan after user approval.
  interface PlanSession {
    userId: string;
    task: string;
    plan: string;
    planMode: "auto" | "always" | "never";
    fullContextToken: boolean;
    projectId?: string;
    maxIterations?: number;
    isolatedWorkspace: boolean;
    continueOnLimit?: boolean;
    phasePlanning?: boolean;
    engine: string;
    createdAt: number;
  }
  const planSessions = new Map<string, PlanSession>();

  // ─── Plan Generation (no execution) ────────────────────────────────────
  router.post("/chat/plan", async (req: Request, res: Response) => {
    const { task, planMode, fullContextToken, projectId, maxIterations, isolatedWorkspace, continueOnLimit, phasePlanning, engine } = req.body as PlanRequest;

    if (!task || typeof task !== "string" || task.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'task' field" };
      res.status(400).json(body);
      return;
    }

    const { userId, isAdmin } = authedUser(req);

    const { limited, retryAfterMs } = checkTaskRateLimit(userId);
    if (limited) {
      res.status(429).json({
        success: false,
        error: `Task submission rate limit exceeded. Try again in ${Math.ceil((retryAfterMs ?? 0) / 1000)}s.`,
      } as ApiResponse);
      return;
    }
    const { cwd, error: projectError } = resolveProjectCwd(userId, isAdmin, projectId);
    if (projectError) {
      res.status(404).json({ success: false, error: projectError } as ApiResponse);
      return;
    }
    const telemetry = new FileTelemetry(cwd);
    const llmConfig = loadLlmConfig();
    applyStoredApiKey(llmConfig);
    const llm = createLlmClient(llmConfig, telemetry);

    const opts: OrchestratorOptions = { cwd, planMode: planMode ?? "always" };
    if (fullContextToken) opts.fullContextToken = true;
    if (maxIterations) opts.maxIterations = maxIterations;
    if (isolatedWorkspace) opts.isolatedWorkspace = true;
    // Map API's phasePlanning (true = enable) to orchestrator's singlePhase (false = enable)
    if (phasePlanning === false) opts.singlePhase = true;
    const resolvedEngine = resolveEngineName(engine);
    const orchestrator = createEngine(resolvedEngine, { llm, telemetry, options: { ...opts, persistToDb: true } });

    try {
      const plan = await orchestrator.generatePlan(task.trim());
      const sessionId = crypto.randomUUID();
      planSessions.set(sessionId, {
        userId,
        task: task.trim(),
        plan,
        planMode: planMode ?? "always",
        fullContextToken: fullContextToken ?? false,
        projectId,
        maxIterations,
        isolatedWorkspace: isolatedWorkspace ?? false,
        continueOnLimit: continueOnLimit ?? false,
        phasePlanning: phasePlanning ?? false,
        engine: resolvedEngine,
        createdAt: Date.now(),
      });

      const data: PlanResponse = { sessionId, plan, task: task.trim(), planMode: planMode ?? "always" };
      const body: ApiResponse<PlanResponse> = { success: true, data };
      res.json(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await telemetry.logError(err, "api/chat/plan");
      const body: ApiResponse = { success: false, error: message };
      res.status(500).json(body);
    }
  });

  // ─── Execute an approved plan ──────────────────────────────────────────
  router.post("/chat/execute", async (req: Request, res: Response) => {
    const { sessionId } = req.body as ExecuteRequest;

    if (!sessionId || typeof sessionId !== "string" || sessionId.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'sessionId' field" };
      res.status(400).json(body);
      return;
    }

    const session = planSessions.get(sessionId);
    if (!session) {
      const body: ApiResponse = { success: false, error: "Invalid or expired sessionId" };
      res.status(404).json(body);
      return;
    }

    const { userId, isAdmin } = authedUser(req);
    if (session.userId !== userId && !isAdmin) {
      // Deliberately the same "not found" shape as an expired/unknown sessionId, rather than a
      // 403 — this doesn't confirm to a caller that a sessionId exists but belongs to someone
      // else, it just looks like any other invalid session.
      const body: ApiResponse = { success: false, error: "Invalid or expired sessionId" };
      res.status(404).json(body);
      return;
    }

    // Clean up the session so it can't be executed twice
    planSessions.delete(sessionId);

    const { cwd, error: projectError } = resolveProjectCwd(userId, isAdmin, session.projectId);
    if (projectError) {
      res.status(404).json({ success: false, error: projectError } as ApiResponse);
      return;
    }
    const telemetry = new FileTelemetry(cwd);
    const llmConfig = loadLlmConfig();
    applyStoredApiKey(llmConfig);
    const llm = createLlmClient(llmConfig, telemetry);

    const opts: OrchestratorOptions = {
      cwd,
      planMode: "never", // Plan already done
      interactive: false,
      onIterationLimitReached: async (_taskDescription: string, _iterationsSoFar: number) => {
        // When continueOnLimit is true, auto-continue without capturing partial context
        if (session.continueOnLimit) return true;
        // Return false to stop — the orchestrator will call synthesizeReport() internally
        // and set lastOutcome to "partial_success". We'll retrieve the partial-success
        // context from getPartialSuccess() after run() completes.
        return false;
      },
    };
    if (session.fullContextToken) opts.fullContextToken = true;
    if (session.maxIterations) opts.maxIterations = session.maxIterations;
    if (session.isolatedWorkspace) opts.isolatedWorkspace = true;
    if (session.continueOnLimit) opts.continueOnLimit = true;
    // Map API's phasePlanning (true = enable) to orchestrator's singlePhase (false = enable)
    if (session.phasePlanning === false) opts.singlePhase = true;
    const orchestrator = createEngine(session.engine, { llm, telemetry, options: { ...opts, persistToDb: true } });

    try {
      const result = await orchestrator.run(session.task);
      const outcome = orchestrator.getLastOutcome();
      const data: ExecuteResponse = { result, iterations: 0 };
      if (outcome !== "completed") {
        data.limitation =
          outcome === "iteration_limit" || outcome === "partial_success"
            ? "The task did not finish within the iteration limit."
            : "The plan was not approved, so no changes were made.";
        if (outcome === "iteration_limit" || outcome === "partial_success") {
          data.iterationMaxReached = true;
          data.continueRequested = true;
        }
      }
      // Include partial-success context when the orchestrator captured it
      const partialSuccess = orchestrator.getPartialSuccess();
      if (partialSuccess) {
        data.partialSuccess = partialSuccess;
      }
      const body: ApiResponse<ExecuteResponse> = { success: true, data };
      res.json(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await telemetry.logError(err, "api/chat/execute");
      const body: ApiResponse = { success: false, error: message };
      res.status(500).json(body);
    }
  });

  // ─── Telemetry ─────────────────────────────────────────────────────────
  router.get("/telemetry", (req: Request, res: Response) => {
    const query = req.query as unknown as TelemetryQuery;
    const logFile = query.log ?? "thinking";
    const limit = query.limit ?? 50;

    const allowed = ["thinking", "llm", "sys"];
    if (!allowed.includes(logFile)) {
      const body: ApiResponse = {
        success: false,
        error: `Invalid log file '${logFile}'. Allowed: ${allowed.join(", ")}`,
      };
      res.status(400).json(body);
      return;
    }

    const logPath = path.join(resolveLogsDir(process.cwd()), `${logFile}.log`);
    if (!fs.existsSync(logPath)) {
      const body: ApiResponse<TelemetryResponse> = {
        success: true,
        data: { logFile, entries: [] },
      };
      res.json(body);
      return;
    }

    const raw = fs.readFileSync(logPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const entries = lines
      .slice(-limit)
      .map((line) => {
        // Each line is: ISO timestamp + JSON
        const spaceIdx = line.indexOf(" ");
        if (spaceIdx === -1) return { raw: line };
        const timestamp = line.slice(0, spaceIdx);
        const json = line.slice(spaceIdx + 1);
        try {
          return { timestamp, data: JSON.parse(json) };
        } catch {
          return { timestamp, raw: json };
        }
      });

    const data: TelemetryResponse = { logFile, entries };
    const body: ApiResponse<TelemetryResponse> = { success: true, data };
    res.json(body);
  });

  // ─── Skills ────────────────────────────────────────────────────────────
  router.get("/skills", (_req: Request, res: Response) => {
    const registry = new SkillRegistry();
    const headers = registry.loadHeaders();
    const skills: SkillListEntry[] = headers.map((h) => ({
      name: h.name,
      role: h.role,
      description: h.description,
      triggers: h.triggers,
      composes_with: h.composes_with,
    }));
    const body: ApiResponse<SkillListEntry[]> = { success: true, data: skills };
    res.json(body);
  });

  // ─── Platform: Tools ────────────────────────────────────────────────────────────────
  // Backs the new Platform > Tools screen. Every registered tool the orchestrator can call,
  // annotated with whether it ships built-in or was added by connecting an integration (so
  // the UI can show e.g. codegraph_tool as available only once CodeGraph is connected).
  router.get("/platform/tools", (_req: Request, res: Response) => {
    const integrationToolNames = new Set(["codegraph_tool"]);
    const tools: PlatformToolEntry[] = TOOL_SCHEMAS
      .filter((t) => !integrationToolNames.has(t.function.name) || isCodegraphConnected())
      .map((t) => ({
        name: t.function.name,
        description: t.function.description,
        source: integrationToolNames.has(t.function.name) ? "integration" : "builtin",
      }));
    const body: ApiResponse<PlatformToolsResponse> = { success: true, data: { tools } };
    res.json(body);
  });

  // ─── Platform: Integrations ─────────────────────────────────────────────────────────
  router.get("/platform/integrations", (_req: Request, res: Response) => {
    const integrations: PlatformIntegrationEntry[] = [
      {
        id: "codegraph",
        name: "CodeGraph",
        description: "Structural code-graph search, dependency/impact analysis, and symbol path-finding over an indexed codebase.",
        connected: isCodegraphConnected(),
      },
    ];
    const body: ApiResponse<PlatformIntegrationsResponse> = { success: true, data: { integrations } };
    res.json(body);
  });  // Connect/update the CodeGraph integration (admin only — this stores a shared API key
  // every tenant's tasks will use when calling codegraph_tool).
  router.post("/platform/integrations/codegraph", requireAdmin, (req: Request, res: Response) => {
    const { baseUrl, apiKey, defaultProjectId } = req.body as ConnectCodegraphRequest;

    if (!baseUrl || typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'baseUrl' field" };
      res.status(400).json(body);
      return;
    }
    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'apiKey' field" };
      res.status(400).json(body);
      return;
    }
    try {
      new URL(baseUrl.trim());
    } catch {
      const body: ApiResponse = { success: false, error: "'baseUrl' must be a valid URL, e.g. http://localhost:8000" };
      res.status(400).json(body);
      return;
    }

    setCodegraphConnection({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), defaultProjectId });
    const body: ApiResponse<{ connected: true }> = { success: true, data: { connected: true } };
    res.json(body);
  });

  // Disconnect CodeGraph (admin only).
  router.delete("/platform/integrations/codegraph", requireAdmin, (_req: Request, res: Response) => {
    clearCodegraphConnection();
    const body: ApiResponse<{ connected: false }> = { success: true, data: { connected: false } };
    res.json(body);
  });

  // ─── CodeGraph: bundled instance lifecycle ──────────────────────────────────────────
  // xcoder ships the whole CodeGraph system (API + MCP server + Explorer UI) under
  // integrations/codegraph/ — see codegraphProcess.ts. These routes let an admin start/stop
  // that bundled instance and auto-connect it, without ever standing up CodeGraph separately
  // or hand-entering a URL/API key (the manual /platform/integrations/codegraph route above
  // still exists for pointing at an externally-hosted CodeGraph instead, if preferred).
  router.get("/platform/integrations/codegraph/status", (_req: Request, res: Response) => {
    const body: ApiResponse = { success: true, data: getCodegraphStatus() };
    res.json(body);
  });

  router.post("/platform/integrations/codegraph/start", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const status = await startBundledCodegraph();
      const body: ApiResponse = { success: true, data: status };
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const body: ApiResponse = { success: false, error: message };
      res.status(500).json(body);
    }
  });

  router.post("/platform/integrations/codegraph/stop", requireAdmin, (_req: Request, res: Response) => {
    const status = stopBundledCodegraph();
    const body: ApiResponse = { success: true, data: status };
    res.json(body);
  });

  // Session info for the embedded CodeGraph Explorer iframe at /codegraph-ui — admin only,
  // since it hands back a real CodeGraph admin session token. The frontend writes this into
  // localStorage (same-origin as the iframe) right before mounting it, so the embedded
  // Explorer comes up already signed in. Returns null if the bundled instance isn't running.
  router.get("/platform/integrations/codegraph/sso", requireAdmin, (_req: Request, res: Response) => {
    const session = getSsoSession();
    const body: ApiResponse = { success: true, data: session };
    res.json(body);
  });

  // ─── Task History (read-only; the agent queries this itself via task_history_tool —
  // this endpoint is purely so the UI can also show it, e.g. a "recent tasks" list) ───────
  router.get("/task-history", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const { cwd } = resolveProjectCwd(userId, isAdmin, req.query.projectId as string | undefined);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;
    const tasks = readTaskHistory(cwd, limit);
    const body: ApiResponse = { success: true, data: { tasks } };
    res.json(body);
  });

  // ─── POST /api/v1/task-history — manually add a task history entry ─────────────────────
  router.post("/task-history", async (req: Request, res: Response) => {
    const { task, summary, iterations, totalTokens } = req.body as {
      task?: string;
      summary?: string;
      iterations?: number;
      totalTokens?: number;
    };

    if (!task || typeof task !== "string" || task.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'task' field" };
      res.status(400).json(body);
      return;
    }

    if (!summary || typeof summary !== "string" || summary.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'summary' field" };
      res.status(400).json(body);
      return;
    }

    const { userId, isAdmin } = authedUser(req);
    const { cwd } = resolveProjectCwd(userId, isAdmin, req.body.projectId as string | undefined);

    // Write to the markdown file
    const { appendTaskHistory } = await import("../core/taskHistory.js");
    const entry = appendTaskHistory(cwd, {
      task: task.trim(),
      summary: summary.trim(),
      iterations: typeof iterations === "number" ? iterations : 0,
      totalTokens: typeof totalTokens === "number" ? totalTokens : undefined,
    });

    // Also persist to PostgreSQL if available
    const store = new TaskHistoryStore();
    await store.save({
      task: task.trim(),
      summary: summary.trim(),
      iterations: typeof iterations === "number" ? iterations : 0,
      totalTokens: typeof totalTokens === "number" ? totalTokens : null,
    }).catch(() => {
      // TaskHistoryStore already logs warnings on failure; no need to re-log
    });

    const body: ApiResponse = { success: true, data: entry };
    res.status(201).json(body);
  });

  // ─── Task History Logs — get telemetry logs for a specific task ───────────────────────
  router.get("/task-history/:taskId/logs", async (req: Request, res: Response) => {
    const taskId = String(req.params.taskId);
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

    // Try to get logs from PostgreSQL if available
    try {
      const { PostgresTelemetry } = await import("../telemetry/postgresTelemetry.js");
      const pgTelemetry = new PostgresTelemetry();
      const logs = await pgTelemetry.getLogsForTask(taskId, limit);
      const body: ApiResponse = { success: true, data: { taskId, logs } };
      res.json(body);
    } catch {
      // Fallback: return empty — file-based telemetry doesn't have task-level indexing
      const body: ApiResponse = { success: true, data: { taskId, logs: [], note: "PostgreSQL telemetry not available. Enable DATABASE_URL for task-level log queries." } };
      res.json(body);
    }
  });

  // ─── Phase Reports ──────────────────────────────────────────────────────
  const phaseReportStore = new PhaseReportStore();

  router.get("/phase-reports", async (req: Request, res: Response) => {
    try {
      const taskId = req.query.taskId as string | undefined;
      if (!taskId) {
        const body: ApiResponse = { success: false, error: "Missing required query param 'taskId'" };
        res.status(400).json(body);
        return;
      }
      const reports = await phaseReportStore.listByTask(taskId);
      const body: ApiResponse = { success: true, data: { reports } };
      res.json(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const body: ApiResponse = { success: false, error: message };
      res.status(500).json(body);
    }
  });

  router.get("/phase-reports/:id", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const report = await phaseReportStore.get(id);
      if (!report) {
        const body: ApiResponse = { success: false, error: "Phase report not found" };
        res.status(404).json(body);
        return;
      }
      const body: ApiResponse = { success: true, data: report };
      res.json(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const body: ApiResponse = { success: false, error: message };
      res.status(500).json(body);
    }
  });

  // ─── WBS (Work Breakdown Structure) ─────────────────────────────────────
  const wbsStore = new WbsStore();

  router.get("/wbs", async (req: Request, res: Response) => {
    try {
      const taskId = req.query.taskId as string | undefined;
      if (!taskId) {
        const body: ApiResponse = { success: false, error: "Missing required query param 'taskId'" };
        res.status(400).json(body);
        return;
      }
      const entries = await wbsStore.listByTask(taskId);
      const body: ApiResponse = { success: true, data: { entries } };
      res.json(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const body: ApiResponse = { success: false, error: message };
      res.status(500).json(body);
    }
  });

  router.put("/wbs/:id/status", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const { status } = req.body as { status: string };

      if (!status || typeof status !== "string") {
        const body: ApiResponse = { success: false, error: "Missing or invalid 'status' field" };
        res.status(400).json(body);
        return;
      }

      const validStatuses = ["pending", "in_progress", "completed", "failed", "skipped"];
      if (!validStatuses.includes(status)) {
        const body: ApiResponse = {
          success: false,
          error: `Invalid status '${status}'. Allowed: ${validStatuses.join(", ")}`,
        };
        res.status(400).json(body);
        return;
      }

      // Look up the WBS entry by ID to get taskId and phaseNumber
      const entry = await wbsStore.get(id);
      if (!entry) {
        const body: ApiResponse = { success: false, error: "WBS entry not found" };
        res.status(404).json(body);
        return;
      }

      const updated = await wbsStore.updateStatus(
        entry.taskId,
        entry.phaseNumber,
        status as "pending" | "in_progress" | "completed" | "failed" | "skipped"
      );

      if (!updated) {
        const body: ApiResponse = { success: false, error: "Failed to update WBS entry status" };
        res.status(500).json(body);
        return;
      }

      const body: ApiResponse = { success: true, data: { id, status } };
      res.json(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const body: ApiResponse = { success: false, error: message };
      res.status(500).json(body);
    }
  });

  // ─── LLM API Key ────────────────────────────────────────────────────────
  // Never returns the actual key — only whether one is set — so a GET can't leak it back out
  // over the wire to anyone who can read the response.
  router.get("/settings/llm-key", (_req: Request, res: Response) => {
    const body: ApiResponse = { success: true, data: { hasKey: hasStoredApiKey() } };
    res.json(body);
  });

  router.put("/settings/llm-key", requireAdmin, (req: Request, res: Response) => {
    const { apiKey } = req.body as { apiKey?: string };
    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
      res.status(400).json({ success: false, error: "'apiKey' is required" } as ApiResponse);
      return;
    }
    setStoredApiKey(apiKey.trim());
    res.json({ success: true, data: { hasKey: true } } as ApiResponse);
  });

  router.delete("/settings/llm-key", requireAdmin, (_req: Request, res: Response) => {
    clearStoredApiKey();
    res.json({ success: true, data: { hasKey: false } } as ApiResponse);
  });

  // ─── User Management ───────────────────────────────────────────────────
  // Persistent user store with password hashing. Loaded from disk on startup (see
  // userStorePersistence.ts for why this exists — previously in-memory only, wiped every
  // restart) and re-saved after every mutation below.
  const storedUsers: StoredUser[] = loadPersistedUsers();
  let nextUserId = nextUserIdAfter(storedUsers);

  // Initialize the auth module's reference to our user store
  setUserStore(storedUsers);

  // ─── Register (no auth required — only works when no users exist) ──────
  router.post("/register", (req: Request, res: Response) => {
    const { username, password } = req.body as CreateUserRequest;

    // Validate inputs first (before checking user count, so validation errors return 400 not 403)
    if (!username || typeof username !== "string" || username.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'username' field" };
      res.status(400).json(body);
      return;
    }

    if (!password || typeof password !== "string" || password.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'password' field" };
      res.status(400).json(body);
      return;
    }

    if (password.length < 4) {
      const body: ApiResponse = { success: false, error: "Password must be at least 4 characters" };
      res.status(400).json(body);
      return;
    }

    // Only allow registration when no users exist
    if (storedUsers.length > 0) {
      const body: ApiResponse = { success: false, error: "Registration is closed. Users can only be added by an admin." };
      res.status(403).json(body);
      return;
    }

    // First user becomes admin
    const newUser: StoredUser = {
      id: String(nextUserId++),
      username: username.trim(),
      passwordHash: hashPassword(password),
      role: "admin",
      createdAt: new Date().toISOString(),
      authProvider: "local",
    };

    storedUsers.push(newUser);
    persistUsers(storedUsers);

    // Auto-login after registration
    const token = generateToken(newUser.id, newUser.username, newUser.role);
    const data: LoginResponse = { token, userId: newUser.id, username: newUser.username, role: newUser.role };
    const body: ApiResponse<LoginResponse> = { success: true, data };
    res.status(201).json(body);
  });

  // ─── Sign in with Google (no auth required — see auth.ts's skip list) ───────────────
  // Handles BOTH first-time self-registration and every subsequent login for a Google
  // account: verify the ID token, then either match an existing "google" user (by googleId,
  // or by email if an admin pre-created the account — see findGoogleUser) or create a new
  // one on the spot. Unlike /register, this is never "closed" once other users exist —
  // Google has already done the identity verification, so a fresh Google sign-in is treated
  // as a normal self-service signup rather than the local-password bootstrap-only flow.
  router.post("/auth/google", async (req: Request, res: Response) => {
    const { credential } = req.body as GoogleLoginRequest;

    if (!credential || typeof credential !== "string") {
      const body: ApiResponse = { success: false, error: "Missing 'credential' field" };
      res.status(400).json(body);
      return;
    }

    const rateLimitKey = `google:${req.ip}`;
    const { limited, retryAfterMs } = checkRateLimit(rateLimitKey);
    if (limited) {
      const body: ApiResponse = {
        success: false,
        error: `Too many sign-in attempts. Try again in ${Math.ceil((retryAfterMs ?? 0) / 1000)}s.`,
      };
      res.status(429).json(body);
      return;
    }

    let identity;
    try {
      identity = await verifyGoogleIdToken(credential);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const body: ApiResponse = { success: false, error: `Google sign-in failed: ${message}` };
      res.status(401).json(body);
      return;
    }

    let user = findGoogleUser(identity.googleId, identity.email);

    if (user) {
      // Backfill googleId the first time an admin-pre-created-by-email account signs in.
      if (!user.googleId) user.googleId = identity.googleId;
    } else {
      // Any username collision with a "local" account of the same handle is avoided by
      // deriving the username from the email's local part plus a short disambiguator.
      const base = identity.email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "") || "google-user";
      let username = base;
      let n = 1;
      while (storedUsers.some((u) => u.username === username)) {
        username = `${base}${n++}`;
      }

      user = {
        id: String(nextUserId++),
        username,
        passwordHash: "",
        // The very first account on a fresh install becomes admin regardless of provider,
        // same bootstrap rule /register uses for local accounts.
        role: storedUsers.length === 0 ? "admin" : "user",
        createdAt: new Date().toISOString(),
        authProvider: "google",
        googleId: identity.googleId,
        email: identity.email,
      };
      storedUsers.push(user);
    }

    persistUsers(storedUsers);

    const token = generateToken(user.id, user.username, user.role);
    const data: LoginResponse = { token, userId: user.id, username: user.username, role: user.role };
    const body: ApiResponse<LoginResponse> = { success: true, data };
    res.json(body);
  });

  // ─── User count (no auth required — used by UI to check if registration is needed) ──
  router.get("/users/count", (_req: Request, res: Response) => {
    const body: ApiResponse<{ count: number }> = { success: true, data: { count: storedUsers.length } };
    res.json(body);
  });

  // List all users
  router.get("/users", requireAdmin, (_req: Request, res: Response) => {
    // Return users without password hashes
    const safeUsers: User[] = storedUsers.map(({ id, username, role, createdAt, authProvider, email }) => ({
      id,
      username,
      role,
      createdAt,
      authProvider,
      email,
    }));
    const body: ApiResponse<User[]> = { success: true, data: safeUsers };
    res.json(body);
  });

  // Create a new user (admin only — protected by authMiddleware). Supports two shapes:
  //   authProvider "local" (default): username + password, same as before.
  //   authProvider "google": email only — no password is set. The account is inert (can't log
  //   in) until whoever owns that Google address signs in via POST /auth/google, which matches
  //   them to this pre-created record by email and backfills its googleId.
  router.post("/users", requireAdmin, (req: Request, res: Response) => {
    const { username, password, role, authProvider, email } = req.body as CreateUserRequest;

    if (authProvider === "google") {
      if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        const body: ApiResponse = { success: false, error: "A valid 'email' field is required for a Google account" };
        res.status(400).json(body);
        return;
      }
      const normalizedEmail = email.trim().toLowerCase();
      if (storedUsers.some((u) => u.authProvider === "google" && u.email?.toLowerCase() === normalizedEmail)) {
        const body: ApiResponse = { success: false, error: "A Google account with that email is already added" };
        res.status(409).json(body);
        return;
      }

      const base = normalizedEmail.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "") || "google-user";
      let derivedUsername = base;
      let n = 1;
      while (storedUsers.some((u) => u.username === derivedUsername)) {
        derivedUsername = `${base}${n++}`;
      }

      const newGoogleUser: StoredUser = {
        id: String(nextUserId++),
        username: derivedUsername,
        passwordHash: "",
        role: role === "admin" ? "admin" : "user",
        createdAt: new Date().toISOString(),
        authProvider: "google",
        email: normalizedEmail,
      };
      storedUsers.push(newGoogleUser);
      persistUsers(storedUsers);

      const safeGoogleUser: User = {
        id: newGoogleUser.id,
        username: newGoogleUser.username,
        role: newGoogleUser.role,
        createdAt: newGoogleUser.createdAt,
        authProvider: "google",
        email: newGoogleUser.email,
      };
      const body: ApiResponse<User> = { success: true, data: safeGoogleUser };
      res.status(201).json(body);
      return;
    }

    if (!username || typeof username !== "string" || username.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'username' field" };
      res.status(400).json(body);
      return;
    }

    if (!password || typeof password !== "string" || password.trim().length === 0) {
      const body: ApiResponse = { success: false, error: "Missing or empty 'password' field" };
      res.status(400).json(body);
      return;
    }

    // Check for duplicate username
    if (storedUsers.some((u) => u.username === username.trim())) {
      const body: ApiResponse = { success: false, error: "Username already exists" };
      res.status(409).json(body);
      return;
    }

    const newUser: StoredUser = {
      id: String(nextUserId++),
      username: username.trim(),
      passwordHash: hashPassword(password),
      role: role === "admin" ? "admin" : "user",
      createdAt: new Date().toISOString(),
      authProvider: "local",
    };

    storedUsers.push(newUser);
    persistUsers(storedUsers);

    const safeUser: User = {
      id: newUser.id,
      username: newUser.username,
      role: newUser.role,
      createdAt: newUser.createdAt,
      authProvider: "local",
    };
    const body: ApiResponse<User> = { success: true, data: safeUser };
    res.status(201).json(body);
  });

  // Update a user
  router.put("/users/:id", requireAdmin, (req: Request, res: Response) => {
    const { id } = req.params;
    const updates = req.body as UpdateUserRequest;
    const user = storedUsers.find((u) => u.id === id);

    if (!user) {
      const body: ApiResponse = { success: false, error: "User not found" };
      res.status(404).json(body);
      return;
    }

    if (updates.username !== undefined) {
      user.username = updates.username.trim();
    }
    if (updates.role !== undefined) {
      user.role = updates.role === "admin" ? "admin" : "user";
    }
    persistUsers(storedUsers);

    const body: ApiResponse<User> = {
      success: true,
      data: { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt },
    };
    res.json(body);
  });

  // Delete a user
  router.delete("/users/:id", requireAdmin, (req: Request, res: Response) => {
    const { id } = req.params;
    const index = storedUsers.findIndex((u) => u.id === id);

    if (index === -1) {
      const body: ApiResponse = { success: false, error: "User not found" };
      res.status(404).json(body);
      return;
    }

    // Prevent deleting the last admin
    if (storedUsers[index].role === "admin" && storedUsers.filter((u) => u.role === "admin").length <= 1) {
      const body: ApiResponse = { success: false, error: "Cannot delete the last admin user" };
      res.status(403).json(body);
      return;
    }

    const deleted = storedUsers.splice(index, 1)[0];
    persistUsers(storedUsers);
    const body: ApiResponse<User> = {
      success: true,
      data: { id: deleted.id, username: deleted.username, role: deleted.role, createdAt: deleted.createdAt },
    };
    res.json(body);
  });

  return router;
}


