import { Router, Request, Response } from "express";
import multer from "multer";
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
import { authMiddleware, requireAdmin, verifyLogin, findGoogleUser, generateToken, revokeToken, setUserStore, getUserStore, hashPassword, isLegacyHash, checkRateLimit, checkTaskRateLimit, checkWorkspaceRateLimit, TOKEN_TTL_MS, StoredUser } from "./auth.js";
import { verifyGoogleIdToken, isGoogleSignInConfigured, getGoogleClientId } from "./googleAuth.js";
import { loadPersistedUsers, persistUsers, nextUserIdAfter } from "./userStorePersistence.js";
import { registerProjectRoutes } from "./projectRoutes.js";
import { registerPlanRoutes } from "./planRoutes.js";
import { listModels, isAllowedModel, type ModelListResult } from "./ollamaModels.js";
import { listProjects, getProject, getActiveProject } from "./projectStore.js";
import { hasStoredApiKey, setStoredApiKey, clearStoredApiKey, applyStoredApiKey } from "./llmKeyStore.js";
import { getCodegraphConnection, isCodegraphConnected, setCodegraphConnection } from "./codegraphKeyStore.js";
import { getStatus as getCodegraphStatus, retryAutoConnectIfNeeded, startBundledCodegraph, stopBundledCodegraph, disconnectCodegraph, getSsoSession } from "./codegraphProcess.js";
import { runCodegraphTool } from "../tools/codegraphTool.js";
import { XCODER_PROXY_COOKIE } from "./codegraphProxy.js";
import { TOOL_SCHEMAS } from "../tools/toolSchemas.js";
import { runSecurityTool } from "../tools/securityOpsTool.js";
import { getAllowlist, setAllowlist } from "./securityOpsAllowlistStore.js";
import { appendAuditLog, readAuditLog } from "./auditLog.js";
import { getLlmConfigSummary, updateLlmConfig, knownProviders, KNOWN_PROVIDER_DEFAULTS } from "./llmConfigStore.js";
import { listWorkspaceDirectory, readWorkspaceFile, writeWorkspaceFile, createWorkspaceDirectory, deleteWorkspacePath, extractZipIntoWorkspace } from "./workspaceFiles.js";
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
  SessionResponse,
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
  SecurityOpsRunRequest,
  SecurityOpsAllowlistResponse,
  AuditLogQuery,
  AuditLogResponse,
  LlmConfigUpdateRequest,
  WorkspaceWriteFileRequest,
  WorkspaceCreateDirRequest,
  WorkspaceUploadZipResponse,
} from "./types.js";

const pkg = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
);

export function createRouter(): Router {
  const router = Router();

  // NOTE: registerProjectRoutes() / registerPlanRoutes() are deliberately NOT called here.
  // They used to be, and that was an authentication bypass: an Express Router dispatches
  // layers in registration order, so every route registered before `router.use(authMiddleware)`
  // (mounted further down) is reachable with no token at all. Registering the /projects and
  // /plans routers at the top of createRouter() therefore left all 16 of their routes fully
  // anonymous — including GET /projects (enumerate every project on the platform),
  // POST /projects/:id/upload, GET /projects/:id/download and DELETE /projects/:id/files
  // (unauthenticated file write / read / delete). Their handlers call authedUser(req), which
  // falls back to `{ userId: "", isAdmin: false }` when authMiddleware never ran, so the
  // requests did not error — they just executed as a blank pseudo-user.
  // They are now registered AFTER authMiddleware, below. Keep them there.

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

  /** Like authedUser() but also surfaces the username, for audit-log entries where "which user
   *  id did this" is far less useful at a glance than "which username did this". */
  function auditActor(req: Request): { actorId: string; actorUsername: string } {
    const user = (req as { user?: { userId: string; username: string } }).user;
    return { actorId: user?.userId ?? "", actorUsername: user?.username ?? "unknown" };
  }

  /** Records one audit-log entry against the server's own cwd — this is a platform-wide log,
   *  not a per-project one, same scope as the existing /telemetry route's thinking.log/sys.log. */
  function recordAudit(req: Request, action: string, summary: string, details?: Record<string, unknown>): void {
    const { actorId, actorUsername } = auditActor(req);
    appendAuditLog(process.cwd(), { actorId, actorUsername, action, summary, details });
  }

  /**
   * Sets the cookie codegraphProxy.ts checks before forwarding any /codegraph-api request — see
   * that file's doc comment for why this has to be a cookie rather than reusing the Bearer
   * token check every other route relies on. Scoped to just the /codegraph-api path (never sent
   * on ordinary /api/v1 calls), httpOnly (no reason for page JS to ever read it directly — the
   * browser attaches it automatically), and sameSite "strict" (never sent on a cross-site
   * request, so it can't be used to probe the proxy from another origin). `secure` mirrors
   * whatever scheme this exact request came in on, so it isn't silently dropped over plain HTTP
   * in local dev while still being marked secure behind TLS in production.
   */
  function setProxyCookie(req: Request, res: Response, token: string): void {
    res.cookie(XCODER_PROXY_COOKIE, token, {
      path: "/codegraph-api",
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      maxAge: TOKEN_TTL_MS,
    });
  }

  function clearProxyCookie(res: Response): void {
    res.clearCookie(XCODER_PROXY_COOKIE, { path: "/codegraph-api" });
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

  /**
   * Validates a caller-supplied model name against the models this server can actually offer.
   *
   * This is an allowlist check, not a sanity check. The value ends up written straight into the
   * outbound LLM request, so accepting it as given would let any authenticated user point the
   * backend at a model the operator never configured — on a reverse-proxied or cloud endpoint,
   * potentially a far more expensive one.
   *
   * Deliberately unlike resolveEngineName() above, which silently falls back to the default for
   * an unrecognized value: an engine name comes from a fixed UI dropdown where a stale value is
   * a harmless client-versioning problem, whereas a model determines what the run costs and how
   * good the output is. Quietly substituting a different model would leave the caller believing
   * they got the one they picked. Returns an error string for the route to turn into a 400.
   */
  async function resolveModelOverride(requested: unknown): Promise<{ model?: string; error?: string }> {
    if (requested === undefined || requested === null) return {};
    if (typeof requested !== "string" || requested.trim().length === 0) {
      return { error: "'model' must be a non-empty string" };
    }
    const wanted = requested.trim();
    const available = await listModels();
    if (!isAllowedModel(wanted, available.models)) {
      return { error: `Unknown model '${wanted}'. Available: ${available.models.join(", ")}` };
    }
    return { model: wanted };
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
    setProxyCookie(req, res, token);
    const data: LoginResponse = { token, userId: verifiedUser.id, username: verifiedUser.username, role: verifiedUser.role };
    const body: ApiResponse<LoginResponse> = { success: true, data };
    res.json(body);
  });

  // ─── Logout (no auth required — we read the token from the header) ──────
  router.post("/logout", (req: Request, res: Response) => {
    clearProxyCookie(res);
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

  // Project and plan routes — registered HERE, after authMiddleware, so every one of them
  // requires a valid token. See the note at the top of createRouter() for what went wrong
  // when these were registered before it.
  registerProjectRoutes(router);
  registerPlanRoutes(router);

  // ─── Engine registry ────────────────────────────────────────────────────
  // Lets the UI populate an engine picker without hardcoding engine names, and confirms
  // which one is the default (currently "sdlc") without the frontend needing to know that
  // out of band. Behind auth: it's only ever read by the Dashboard and Settings pages, both
  // of which are post-login, so there's no reason to expose the platform's engine inventory
  // to anonymous callers.
  router.get("/engines", (_req: Request, res: Response) => {
    const data: EnginesResponse = { engines: listEngines(), default: DEFAULT_ENGINE };
    const body: ApiResponse<EnginesResponse> = { success: true, data };
    res.json(body);
  });

  // ─── Available models ──────────────────────────────────────────────────
  // Backs the Chat tab's model picker. See ollamaModels.ts for why this never returns an
  // empty list even when Ollama is unreachable.
  router.get("/models", async (_req: Request, res: Response) => {
    const data = await listModels();
    res.json({ success: true, data } as ApiResponse<ModelListResult>);
  });

  // ─── Current session ───────────────────────────────────────────────────
  // "Is the token I'm holding still good, and who does it belong to?" The frontend restores a
  // token from localStorage on boot, but the server's token store is in-memory (see auth.ts) —
  // it's wiped on every API restart, and tokens expire after TOKEN_TTL_MS regardless. Without
  // this endpoint the UI had no way to find that out except by rendering the whole signed-in
  // app and waiting for some unrelated request to fail. This gives it a single cheap probe to
  // call before it shows anything, and on a schedule afterwards.
  //
  // Doing no work beyond reading what authMiddleware already validated is deliberate: the
  // useful signal here is entirely in the status code (200 = good, 401/403 = drop the session).
  router.get("/auth/me", (req: Request, res: Response) => {
    const user = (req as { user?: { userId: string; username: string; role: "admin" | "user"; expiresAt: number } }).user;
    if (!user) {
      // Unreachable in practice — authMiddleware runs first and rejects anything without a
      // valid token — but returning 401 rather than an empty 200 keeps the "no session" answer
      // consistent for any caller that somehow gets here.
      res.status(401).json({ success: false, error: "Missing Authorization header" } as ApiResponse);
      return;
    }
    const data: SessionResponse = {
      userId: user.userId,
      username: user.username,
      role: user.role,
      expiresAt: user.expiresAt,
    };
    res.json({ success: true, data } as ApiResponse<SessionResponse>);
  });

  // ─── Chat / Task Execution ─────────────────────────────────────────────
  router.post("/chat", async (req: Request, res: Response) => {
    const { task, planMode, fullContextToken, projectId, maxIterations, isolatedWorkspace, continueOnLimit, phasePlanning, engine, model } = req.body as ChatRequest;

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
    const { model: overrideModel, error: modelError } = await resolveModelOverride(model);
    if (modelError) {
      res.status(400).json({ success: false, error: modelError } as ApiResponse);
      return;
    }

    const telemetry = new FileTelemetry(cwd);
    const llmConfig = loadLlmConfig();
    applyStoredApiKey(llmConfig);
    if (overrideModel) llmConfig.model = overrideModel;
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
          model: overrideModel,
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
    /** Validated model override chosen at plan time, if any. Carried through to /chat/execute
     *  so the approved plan actually runs on the model the user picked — re-reading the
     *  request body at execute time isn't an option, since that request carries only a
     *  sessionId. Already allowlist-checked by resolveModelOverride() before landing here. */
    model?: string;
    createdAt: number;
  }
  const planSessions = new Map<string, PlanSession>();

  // ─── Plan Generation (no execution) ────────────────────────────────────
  router.post("/chat/plan", async (req: Request, res: Response) => {
    const { task, planMode, fullContextToken, projectId, maxIterations, isolatedWorkspace, continueOnLimit, phasePlanning, engine, model } = req.body as PlanRequest;

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
    const { model: overrideModel, error: modelError } = await resolveModelOverride(model);
    if (modelError) {
      res.status(400).json({ success: false, error: modelError } as ApiResponse);
      return;
    }

    const telemetry = new FileTelemetry(cwd);
    const llmConfig = loadLlmConfig();
    applyStoredApiKey(llmConfig);
    if (overrideModel) llmConfig.model = overrideModel;
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
        model: overrideModel,
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
    // Whatever model the plan was drafted with is what executes it — see PlanSession.model.
    if (session.model) llmConfig.model = session.model;
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

  // ─── Audit Log ─────────────────────────────────────────────────────────
  // Read-only view of .agent/logs/audit.jsonl (see auditLog.ts). Admin-only — this is a record
  // of what other admins have done, so the same access boundary as /users applies. Every write
  // side of this (recordAudit() calls above) already only fires from inside requireAdmin routes;
  // this route just closes the loop by also gating the read side.
  router.get("/audit-log", requireAdmin, (req: Request, res: Response) => {
    const query = req.query as unknown as AuditLogQuery;
    const limit = query.limit ?? 200;
    const entries = readAuditLog(process.cwd(), limit);
    const body: ApiResponse<AuditLogResponse> = { success: true, data: { entries } };
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
    recordAudit(req, "codegraph.connect_external", `connected external CodeGraph instance at ${baseUrl.trim()}`, { baseUrl: baseUrl.trim(), defaultProjectId });
    const body: ApiResponse<{ connected: true }> = { success: true, data: { connected: true } };
    res.json(body);
  });

  // Disconnect CodeGraph (admin only).
  router.delete("/platform/integrations/codegraph", requireAdmin, (req: Request, res: Response) => {
    // Route through codegraphProcess.ts's disconnectCodegraph() rather than clearing
    // codegraphKeyStore directly — it also tears down any locally-spawned process and resets
    // codegraphProcess.ts's own state, so the two can't drift out of sync (state saying
    // "running" while the actual connection was already cleared out from under it).
    const status = disconnectCodegraph();
    recordAudit(req, "codegraph.disconnect", "disconnected CodeGraph integration");
    const body: ApiResponse<{ connected: false; status: typeof status }> = { success: true, data: { connected: false, status } };
    res.json(body);
  });

  // ─── CodeGraph: bundled instance lifecycle ──────────────────────────────────────────
  // xcoder ships the whole CodeGraph system (API + MCP server + Explorer UI) under
  // integrations/codegraph/ — see codegraphProcess.ts. These routes let an admin start/stop
  // that bundled instance and auto-connect it, without ever standing up CodeGraph separately
  // or hand-entering a URL/API key (the manual /platform/integrations/codegraph route above
  // still exists for pointing at an externally-hosted CodeGraph instead, if preferred).
  router.get("/platform/integrations/codegraph/status", (_req: Request, res: Response) => {
    // Polled by the Explorer page while it waits for CodeGraph — doubles as the trigger that
    // retries a sibling-service connection that timed out or was lost (throttled internally).
    retryAutoConnectIfNeeded();
    const body: ApiResponse = { success: true, data: getCodegraphStatus() };
    res.json(body);
  });

  router.post("/platform/integrations/codegraph/start", requireAdmin, async (req: Request, res: Response) => {
    try {
      const status = await startBundledCodegraph();
      recordAudit(req, "codegraph.start", "started bundled CodeGraph instance");
      const body: ApiResponse = { success: true, data: status };
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const body: ApiResponse = { success: false, error: message };
      res.status(500).json(body);
    }
  });

  router.post("/platform/integrations/codegraph/stop", requireAdmin, (req: Request, res: Response) => {
    const status = stopBundledCodegraph();
    recordAudit(req, "codegraph.stop", "stopped bundled CodeGraph instance");
    const body: ApiResponse = { success: true, data: status };
    res.json(body);
  });

  // Session info for the embedded CodeGraph Explorer iframe at /codegraph-ui — admin only,
  // since it hands back a real CodeGraph admin session token. The frontend writes this into
  // localStorage (same-origin as the iframe) right before mounting it, so the embedded
  // Explorer comes up already signed in. Returns null if the bundled instance isn't running.
  router.get("/platform/integrations/codegraph/sso", requireAdmin, (req: Request, res: Response) => {
    // Also (re)issue the proxy cookie codegraphProxy.ts requires. It's normally set at login, but
    // a browser that's still using a token from before that cookie existed (or one whose cookie
    // expired/was cleared while the localStorage token lives on) has no cookie — and then every
    // request the embedded Explorer makes to /codegraph-api gets a 401, which renders as a blank
    // or empty panel with nothing to indicate why. This call is authenticated by the Bearer
    // token, so it's a safe place to hand the cookie back.
    const bearer = req.headers.authorization?.split(" ");
    if (bearer?.length === 2 && bearer[0] === "Bearer") setProxyCookie(req, res, bearer[1]);
    const session = getSsoSession();
    const body: ApiResponse = { success: true, data: session };
    res.json(body);
  });

  // Index an xcoder project's workspace into CodeGraph: zips it (respecting the same exclusion
  // set as the project-download route), uploads it as a CodeGraph project, and triggers static
  // analysis. Same underlying logic as codegraph_tool's action='index_workspace' (so an engine
  // can also trigger this conversationally) — this route is the direct "Index this workspace"
  // button on the CodeGraph Explorer / Platform > Tools pages for people who'd rather not go
  // through chat. Open to any authenticated user for their own project (or any project, for
  // admins) — same visibility rule as every other project-scoped route.
  router.post("/platform/integrations/codegraph/index-workspace", async (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    // Reuses the task-submission limiter (30/hour/user by default) rather than a bespoke one —
    // indexing is comparably expensive (zips, uploads, and triggers real static analysis on a
    // whole project), and this route was previously unrated-limited entirely, letting any
    // authenticated non-admin user trigger it in a tight loop against shared CodeGraph/xcoder
    // resources.
    const { limited, retryAfterMs } = checkTaskRateLimit(userId);
    if (limited) {
      const body: ApiResponse = {
        success: false,
        error: `Too many indexing requests. Try again in ${Math.ceil((retryAfterMs ?? 0) / 1000)}s.`,
      };
      res.status(429).json(body);
      return;
    }
    const { projectId, projectName } = req.body as { projectId?: string; projectName?: string };
    const { cwd, error } = resolveProjectCwd(userId, isAdmin, projectId);
    if (error) {
      const body: ApiResponse = { success: false, error };
      res.status(404).json(body);
      return;
    }
    try {
      const result = await runCodegraphTool({ action: "index_workspace", projectName }, cwd);
      const body: ApiResponse = { success: true, data: JSON.parse(result) };
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const body: ApiResponse = { success: false, error: message };
      res.status(500).json(body);
    }
  });

  // ─── Security Ops: Blue Team / Red Team ─────────────────────────────────────────────
  // Backs the Security Ops page and lets any engine call the same checks via
  // security_ops_tool (src/tools/toolDispatcher.ts). Every red-team action that names a
  // network target (plus blue's cert_expiry_check) is refused server-side by
  // securityOpsAllowlistStore.ts's requireAllowedTarget() regardless of what hits this route —
  // the allowlist routes below just let an admin manage that list from the UI instead of only
  // via the XCODER_SECOPS_ALLOWLIST env var.
  router.get("/security-ops/allowlist", (_req: Request, res: Response) => {
    const body: ApiResponse<SecurityOpsAllowlistResponse> = { success: true, data: { allowlist: getAllowlist() } };
    res.json(body);
  });

  // Admin-only: replaces the allowlist wholesale (localhost/127.0.0.1/::1 are always kept —
  // see securityOpsAllowlistStore.ts's setAllowlist(), which re-adds them unconditionally).
  router.put("/security-ops/allowlist", requireAdmin, (req: Request, res: Response) => {
    const { entries } = req.body as { entries?: string[] };
    if (!Array.isArray(entries) || entries.some((e) => typeof e !== "string")) {
      const body: ApiResponse = { success: false, error: "Body must be { entries: string[] }" };
      res.status(400).json(body);
      return;
    }
    const allowlist = setAllowlist(entries);
    recordAudit(req, "security_ops.allowlist_update", `updated Security Ops target allowlist (${allowlist.length} entries)`, { allowlist });
    const body: ApiResponse<SecurityOpsAllowlistResponse> = { success: true, data: { allowlist } };
    res.json(body);
  });

  // Run a single Blue/Red Team check. Open to any authenticated user (same access level as
  // running a task) — the allowlist is the real security boundary for anything network-facing,
  // not who can reach this route. Shares the task-submission rate limiter: these checks spawn
  // real subprocesses / make real network probes, so this shouldn't be hammerable any more than
  // task submission itself is.
  router.post("/security-ops/run", async (req: Request, res: Response) => {
    const { userId } = authedUser(req);
    const { limited, retryAfterMs } = checkTaskRateLimit(userId);
    if (limited) {
      const body: ApiResponse = {
        success: false,
        error: `Too many security-ops requests. Try again in ${Math.ceil((retryAfterMs ?? 0) / 1000)}s.`,
      };
      res.status(429).json(body);
      return;
    }
    const { team, toolId, params } = req.body as SecurityOpsRunRequest;
    if (team !== "blue" && team !== "red") {
      const body: ApiResponse = { success: false, error: "'team' must be 'blue' or 'red'" };
      res.status(400).json(body);
      return;
    }
    if (!toolId || typeof toolId !== "string") {
      const body: ApiResponse = { success: false, error: "Missing 'toolId'" };
      res.status(400).json(body);
      return;
    }
    const result = await runSecurityTool(team, toolId, params ?? {});
    const body: ApiResponse<typeof result> = { success: true, data: result };
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
    recordAudit(req, "settings.llm_key_update", "updated the platform LLM API key");
    res.json({ success: true, data: { hasKey: true } } as ApiResponse);
  });

  router.delete("/settings/llm-key", requireAdmin, (req: Request, res: Response) => {
    clearStoredApiKey();
    recordAudit(req, "settings.llm_key_delete", "cleared the platform LLM API key");
    res.json({ success: true, data: { hasKey: false } } as ApiResponse);
  });

  // ─── LLM Provider Config ────────────────────────────────────────────────
  // Backs Settings > LLM Provider — lets an admin pick a provider (Ollama by default, matching
  // agent/config/llm.yaml's shipped default) and its model/base_url/endpoint/api_key_env without
  // hand-editing the yaml file. See llmConfigStore.ts for why this is a targeted line-level
  // edit rather than a full yaml.load()/dump() round-trip (dump() would strip every explanatory
  // comment in that file).
  router.get("/settings/llm-config", (_req: Request, res: Response) => {
    try {
      const data = getLlmConfigSummary();
      const body: ApiResponse<typeof data> = { success: true, data };
      res.json(body);
    } catch (err) {
      const body: ApiResponse = { success: false, error: err instanceof Error ? err.message : String(err) };
      res.status(500).json(body);
    }
  });

  router.get("/settings/llm-providers", (_req: Request, res: Response) => {
    const body: ApiResponse = { success: true, data: { providers: knownProviders(), defaults: KNOWN_PROVIDER_DEFAULTS, default: "ollama" } };
    res.json(body);
  });

  router.put("/settings/llm-config", requireAdmin, (req: Request, res: Response) => {
    const update = req.body as LlmConfigUpdateRequest;
    if (update.max_tokens !== undefined && (typeof update.max_tokens !== "number" || update.max_tokens <= 0)) {
      res.status(400).json({ success: false, error: "'max_tokens' must be a positive number" } as ApiResponse);
      return;
    }
    if (update.temperature !== undefined && (typeof update.temperature !== "number" || update.temperature < 0 || update.temperature > 2)) {
      res.status(400).json({ success: false, error: "'temperature' must be a number between 0 and 2" } as ApiResponse);
      return;
    }
    try {
      const data = updateLlmConfig(update);
      recordAudit(req, "settings.llm_config_update", `switched LLM provider to '${data.provider}' (model '${data.model}')`, { ...update });
      const body: ApiResponse<typeof data> = { success: true, data };
      res.json(body);
    } catch (err) {
      const body: ApiResponse = { success: false, error: err instanceof Error ? err.message : String(err) };
      res.status(500).json(body);
    }
  });

  // ─── Workspace file browser ─────────────────────────────────────────────
  // Backs the new Workspace page: list/read/write/create/delete files inside a project. Always
  // confined to the resolved project root (see workspaceFiles.ts's module doc for why this is
  // unconditional here, unlike the LLM tool layer's opt-in XCODER_RESTRICT_TO_WORKSPACE).
  router.get("/workspace/files", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const { cwd, error } = resolveProjectCwd(userId, isAdmin, req.query.projectId as string | undefined);
    if (error) {
      res.status(404).json({ success: false, error } as ApiResponse);
      return;
    }
    const dirPath = (req.query.path as string | undefined) ?? ".";
    try {
      const entries = listWorkspaceDirectory(cwd, dirPath);
      const body: ApiResponse = { success: true, data: { path: dirPath, entries } };
      res.json(body);
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  router.get("/workspace/file", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const { cwd, error } = resolveProjectCwd(userId, isAdmin, req.query.projectId as string | undefined);
    if (error) {
      res.status(404).json({ success: false, error } as ApiResponse);
      return;
    }
    const filePath = req.query.path as string | undefined;
    if (!filePath) {
      res.status(400).json({ success: false, error: "Missing 'path' query param" } as ApiResponse);
      return;
    }
    try {
      const { content, size } = readWorkspaceFile(cwd, filePath);
      const body: ApiResponse = { success: true, data: { path: filePath, content, size } };
      res.json(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const notFound = (err as NodeJS.ErrnoException)?.code === "ENOENT";
      res.status(notFound ? 404 : 400).json({ success: false, error: message } as ApiResponse);
    }
  });

  router.put("/workspace/file", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const { limited, retryAfterMs } = checkWorkspaceRateLimit(userId);
    if (limited) {
      res.status(429).json({ success: false, error: `Too many workspace edits. Try again in ${Math.ceil((retryAfterMs ?? 0) / 1000)}s.` } as ApiResponse);
      return;
    }
    const { projectId, path: filePath, content } = req.body as WorkspaceWriteFileRequest;
    const { cwd, error } = resolveProjectCwd(userId, isAdmin, projectId);
    if (error) {
      res.status(404).json({ success: false, error } as ApiResponse);
      return;
    }
    if (!filePath || typeof filePath !== "string") {
      res.status(400).json({ success: false, error: "Missing 'path'" } as ApiResponse);
      return;
    }
    if (typeof content !== "string") {
      res.status(400).json({ success: false, error: "Missing 'content' (must be a string — use an empty string for a blank new file)" } as ApiResponse);
      return;
    }
    try {
      writeWorkspaceFile(cwd, filePath, content);
      const body: ApiResponse = { success: true, data: { path: filePath, size: Buffer.byteLength(content, "utf-8") } };
      res.json(body);
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  router.post("/workspace/dir", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const { limited, retryAfterMs } = checkWorkspaceRateLimit(userId);
    if (limited) {
      res.status(429).json({ success: false, error: `Too many workspace edits. Try again in ${Math.ceil((retryAfterMs ?? 0) / 1000)}s.` } as ApiResponse);
      return;
    }
    const { projectId, path: dirPath } = req.body as WorkspaceCreateDirRequest;
    const { cwd, error } = resolveProjectCwd(userId, isAdmin, projectId);
    if (error) {
      res.status(404).json({ success: false, error } as ApiResponse);
      return;
    }
    if (!dirPath || typeof dirPath !== "string") {
      res.status(400).json({ success: false, error: "Missing 'path'" } as ApiResponse);
      return;
    }
    try {
      createWorkspaceDirectory(cwd, dirPath);
      const body: ApiResponse = { success: true, data: { path: dirPath } };
      res.json(body);
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
  });

  // Upload a .zip and extract it into a workspace directory (multipart/form-data: field "file"
  // is the zip, form fields "projectId" and "path" behave the same as the routes above — "path"
  // is the target directory the zip's contents land in, not a filename). Real bytes go through
  // multer's in-memory storage (fine at these size limits — see workspaceFiles.ts's MAX_* zip
  // guards, which are far more conservative than the 100MB upload ceiling here) rather than a
  // temp file, keeping this consistent with how /projects/:id/upload already handles uploads.
  const zipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }).single("file");
  router.post("/workspace/upload-zip", (req: Request, res: Response) => {
    zipUpload(req, res, (multerErr) => {
      if (multerErr) {
        const message = multerErr instanceof multer.MulterError && multerErr.code === "LIMIT_FILE_SIZE"
          ? "Zip file is over the 100MB upload limit."
          : multerErr instanceof Error ? multerErr.message : String(multerErr);
        res.status(400).json({ success: false, error: message } as ApiResponse);
        return;
      }

      const { userId, isAdmin } = authedUser(req);
      const { limited, retryAfterMs } = checkWorkspaceRateLimit(userId);
      if (limited) {
        res.status(429).json({ success: false, error: `Too many workspace edits. Try again in ${Math.ceil((retryAfterMs ?? 0) / 1000)}s.` } as ApiResponse);
        return;
      }

      const { projectId, path: dirPath } = req.body as { projectId?: string; path?: string };
      const { cwd, error } = resolveProjectCwd(userId, isAdmin, projectId);
      if (error) {
        res.status(404).json({ success: false, error } as ApiResponse);
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, error: "No file provided (expected multipart field 'file')" } as ApiResponse);
        return;
      }
      if (!req.file.originalname.toLowerCase().endsWith(".zip")) {
        res.status(400).json({ success: false, error: "Only .zip files are accepted here." } as ApiResponse);
        return;
      }

      try {
        const targetPath = dirPath || ".";
        const result = extractZipIntoWorkspace(cwd, targetPath, req.file.buffer);
        recordAudit(
          req,
          "workspace.zip_upload",
          `extracted ${result.filesExtracted} file(s) from "${req.file.originalname}" into ${projectId ?? "the active project"}${targetPath !== "." ? `/${targetPath}` : ""}`,
          { projectId, path: targetPath, filesExtracted: result.filesExtracted, bytesWritten: result.bytesWritten }
        );
        const data: WorkspaceUploadZipResponse = { path: targetPath, ...result };
        const body: ApiResponse<WorkspaceUploadZipResponse> = { success: true, data };
        res.json(body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // WorkspaceZipError and the confinement errors are all caller-fixable (bad zip, path
        // escape, over budget) — 400, not 500.
        res.status(400).json({ success: false, error: message } as ApiResponse);
      }
    });
  });

  router.delete("/workspace/file", (req: Request, res: Response) => {
    const { userId, isAdmin } = authedUser(req);
    const { limited, retryAfterMs } = checkWorkspaceRateLimit(userId);
    if (limited) {
      res.status(429).json({ success: false, error: `Too many workspace edits. Try again in ${Math.ceil((retryAfterMs ?? 0) / 1000)}s.` } as ApiResponse);
      return;
    }
    const { cwd, error } = resolveProjectCwd(userId, isAdmin, req.query.projectId as string | undefined);
    if (error) {
      res.status(404).json({ success: false, error } as ApiResponse);
      return;
    }
    const targetPath = req.query.path as string | undefined;
    if (!targetPath) {
      res.status(400).json({ success: false, error: "Missing 'path' query param" } as ApiResponse);
      return;
    }
    try {
      deleteWorkspacePath(cwd, targetPath);
      const body: ApiResponse = { success: true, data: { path: targetPath, deleted: true } };
      res.json(body);
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) } as ApiResponse);
    }
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
    setProxyCookie(req, res, token);
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
    setProxyCookie(req, res, token);
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
      recordAudit(req, "user.create", `created Google-linked user '${derivedUsername}' (${newGoogleUser.role})`, { userId: newGoogleUser.id, username: derivedUsername, role: newGoogleUser.role, authProvider: "google" });

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
    recordAudit(req, "user.create", `created local user '${newUser.username}' (${newUser.role})`, { userId: newUser.id, username: newUser.username, role: newUser.role, authProvider: "local" });

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
    recordAudit(req, "user.update", `updated user '${user.username}' (id ${user.id}, now ${user.role})`, { userId: user.id, username: user.username, role: user.role });

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
    recordAudit(req, "user.delete", `deleted user '${deleted.username}' (id ${deleted.id})`, { userId: deleted.id, username: deleted.username, role: deleted.role });
    const body: ApiResponse<User> = {
      success: true,
      data: { id: deleted.id, username: deleted.username, role: deleted.role, createdAt: deleted.createdAt },
    };
    res.json(body);
  });

  return router;
}


