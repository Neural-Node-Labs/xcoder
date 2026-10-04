import type { Request, Response, Router, RequestHandler } from "express";
import { requireAdmin } from "./auth.js";
import { withSpan, setSpanAttrs, markSpanError } from "../telemetry/otel.js";
import { redactAndTruncate } from "../telemetry/redact.js";

/**
 * Authenticated gateway to the AGI DevOps harness (integrations/agi), which runs as its OWN
 * privilege-separated service (supervisor + agent + isolated sandbox) and has no user accounts.
 *
 * Why a gateway instead of embedding it: the AGI's safety model depends on process and container
 * boundaries (root supervisor, uid-1001 agent, an `internal: true` sandbox network). Importing it
 * into xcoder's API process would throw those away. Instead xcoder:
 *   - authenticates every call with its normal bearer-token auth (all routes registered AFTER
 *     authMiddleware, so routeAuthCoverage.test.ts covers them),
 *   - authorises by role (below), validates every body field-by-field (never spreads client JSON
 *     upstream), caps sizes/timeouts/concurrency,
 *   - talks to AGI with a shared secret (XCODER_AGI_TOKEN == AGI's AGI_API_TOKEN) over the private
 *     compose network, and strips everything else (cookies, the user's own bearer token).
 *
 * Role policy — the AGI is ONE shared agent instance, so its activity feed (spans carry other
 * users' prompts and tool arguments) and its controls are not multi-tenant safe:
 *   any authenticated user : status, goal (read), skills, chat (own session, rate-limited)
 *   admin only             : activity stream/recent, approvals, evolutions, KPI measure/practice,
 *                            goal edits, knowledge, kill switch, schedule (autonomous loop + token allowance)
 *
 * Config: XCODER_AGI_URL (e.g. http://agi:7000) enables it; XCODER_AGI_TOKEN is the shared secret.
 * Unset URL = feature off: GET /agi/status reports `configured: false`, everything else is 503.
 */

export interface AgiGatewayDeps {
  getUser(req: Request): { userId: string; isAdmin: boolean };
  /** Per-user task limiter (same bucket as /chat) — chat triggers real LLM + sandbox work. */
  checkTaskRateLimit(userId: string): { limited: boolean; retryAfterMs?: number };
  /** Optional audit sink for admin mutations. */
  audit?(req: Request, action: string, summary: string, details?: Record<string, unknown>): void;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHORT_TIMEOUT_MS = 8_000;
/** Measuring KPIs / practice / chat run real sandbox work with an LLM loop — minutes, not seconds. */
const LONG_TIMEOUT_MS = 10 * 60_000;
const MAX_SSE_PER_USER = 3;
const MAX_SSE_TOTAL = 20;

export function agiConfig(env: NodeJS.ProcessEnv = process.env): { base?: string; token: string } {
  const raw = (env.XCODER_AGI_URL ?? "").trim();
  let base: string | undefined;
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "http:" || u.protocol === "https:") base = u.origin; // origin only: no path/creds can sneak in
    } catch {
      /* invalid URL → treated as not configured */
    }
  }
  return { base, token: env.XCODER_AGI_TOKEN ?? "" };
}

type Json = Record<string, unknown>;
const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });
const fail = (res: Response, status: number, error: string) => res.status(status).json({ success: false, error });

export function registerAgiRoutes(router: Router, deps: AgiGatewayDeps): void {
  const cfg = () => agiConfig(deps.env);
  const doFetch = deps.fetchImpl ?? fetch;
  const sseByUser = new Map<string, number>();
  let sseTotal = 0;

  /** Calls the AGI service. Never throws: returns {status, body} or a synthesized 502/503/504. */
  async function upstream(method: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: any; synthetic?: boolean }> {
    const { base, token } = cfg();
    if (!base) return { status: 503, synthetic: true, body: { error: "AGI service is not configured (set XCODER_AGI_URL)" } };
    return withSpan("agi.proxy", { "http.request.method": method, "xcoder.agi.path": path.replace(/[A-Za-z0-9_-]{8,}/g, ":id") }, async (span) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await doFetch(base + path, {
          method,
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctl.signal,
          redirect: "error", // never follow a redirect off the configured host
        });
        const text = await r.text();
        let parsed: unknown = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { error: "AGI service returned a non-JSON response" };
        }
        setSpanAttrs(span, { "http.response.status_code": r.status });
        if (r.status >= 500) markSpanError(span, `upstream ${r.status}`);
        return { status: r.status, body: parsed };
      } catch (err) {
        const aborted = (err as { name?: string })?.name === "AbortError";
        markSpanError(span, aborted ? "timeout" : "unreachable");
        return { status: aborted ? 504 : 502, synthetic: true, body: { error: aborted ? "AGI service timed out" : "AGI service is unreachable" } };
      } finally {
        clearTimeout(t);
      }
    });
  }

  /** Forward and translate to xcoder's ApiResponse envelope. */
  async function relay(res: Response, method: string, path: string, body?: unknown, timeoutMs = SHORT_TIMEOUT_MS): Promise<void> {
    const r = await upstream(method, path, body, timeoutMs);
    if (r.status >= 200 && r.status < 300) return void ok(res, r.body, r.status);
    // Surface upstream 4xx semantics (423 kill switch, 409 busy, 404 …); hide upstream 5xx internals.
    const status = r.status >= 400 && r.status < 500 ? r.status : r.status === 503 || r.status === 504 ? r.status : 502;
    // Only the gateway's OWN 5xx messages are shown; a real upstream 5xx body may carry stack
    // traces / paths / secrets, so it is replaced by a generic message.
    if (status >= 500) return void fail(res, status, r.synthetic ? String(r.body?.error) : "AGI service error");
    return void fail(res, status, redactAndTruncate(r.body?.error ?? `AGI request failed (${r.status})`, 300));
  }

  const adminOnly: RequestHandler = (req, res, next) => requireAdmin(req, res, next);
  const wrap = (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler => (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
  const audit = (req: Request, action: string, summary: string, details?: Record<string, unknown>) => {
    try {
      deps.audit?.(req, `agi.${action}`, summary, details);
    } catch {
      /* auditing must not break the request */
    }
  };
  const goodId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

  // ─── Status (any user) — also the "is it set up?" probe the UI uses ──────────────────────
  router.get("/agi/status", wrap(async (req, res) => {
    const { base } = cfg();
    const { isAdmin } = deps.getUser(req);
    if (!base) return void ok(res, { configured: false, isAdmin });
    const r = await upstream("GET", "/status", undefined, 4_000);
    if (r.status !== 200) return void ok(res, { configured: true, reachable: false, isAdmin, error: String(r.body?.error ?? `HTTP ${r.status}`) });
    ok(res, { configured: true, reachable: true, isAdmin, ...(r.body as Json) });
  }));

  // ─── Read-only for any user ─────────────────────────────────────────────────────────────
  router.get("/agi/goal", wrap((_req, res) => relay(res, "GET", "/goal")));
  router.get("/agi/skills", wrap((_req, res) => relay(res, "GET", "/skills")));

  // ─── Chat (any user; own session; rate-limited; validated) ───────────────────────────────
  router.post("/agi/chat", wrap(async (req, res) => {
    const { userId } = deps.getUser(req);
    const { message, history } = (req.body ?? {}) as { message?: unknown; history?: unknown };
    if (typeof message !== "string" || !message.trim()) return void fail(res, 400, "Missing or empty 'message'");
    if (message.length > 4000) return void fail(res, 400, "'message' exceeds 4000 characters");
    let hist: Array<{ role: "user" | "agent"; text: string }> | undefined;
    if (history !== undefined) {
      if (!Array.isArray(history) || history.length > 12) return void fail(res, 400, "'history' must be an array of at most 12 entries");
      hist = [];
      for (const h of history as Array<Record<string, unknown>>) {
        if (!h || (h.role !== "user" && h.role !== "agent") || typeof h.text !== "string" || h.text.length > 4000) return void fail(res, 400, "'history' entries must be {role: 'user'|'agent', text: string≤4000}");
        hist.push({ role: h.role, text: h.text });
      }
    }
    const { limited, retryAfterMs } = deps.checkTaskRateLimit(userId);
    if (limited) {
      res.setHeader("Retry-After", String(Math.ceil((retryAfterMs ?? 60_000) / 1000)));
      return void fail(res, 429, "Too many AGI requests. Try again later.");
    }
    // Session is derived from the authenticated user — never client-chosen — so one user can't
    // address (or read context from) another user's AGI session.
    const session = `u${userId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "anon"}`;
    await relay(res, "POST", "/chat", { message, session, history: hist }, LONG_TIMEOUT_MS);
  }));

  // ─── Admin: observability + control ──────────────────────────────────────────────────────
  router.get("/agi/recent", adminOnly, wrap((_req, res) => relay(res, "GET", "/recent")));
  router.get("/agi/approvals", adminOnly, wrap((_req, res) => relay(res, "GET", "/approvals")));
  router.get("/agi/evolutions", adminOnly, wrap((_req, res) => relay(res, "GET", "/evolutions")));

  router.put("/agi/goal", adminOnly, wrap(async (req, res) => {
    const b = (req.body ?? {}) as { statement?: unknown; autonomy?: unknown };
    const patch: { statement?: string; autonomy?: number } = {};
    if (b.statement !== undefined) {
      if (typeof b.statement !== "string" || !b.statement.trim() || b.statement.length > 500) return void fail(res, 400, "'statement' must be a non-empty string ≤500 chars");
      patch.statement = b.statement;
    }
    if (b.autonomy !== undefined) {
      if (!Number.isInteger(b.autonomy) || (b.autonomy as number) < 0 || (b.autonomy as number) > 3) return void fail(res, 400, "'autonomy' must be an integer 0-3");
      patch.autonomy = b.autonomy as number;
    }
    audit(req, "goal_update", "updated AGI goal/autonomy", patch);
    await relay(res, "PUT", "/goal", patch);
  }));

  router.post("/agi/goal/measure", adminOnly, wrap(async (req, res) => { audit(req, "measure", "ran AGI KPI measurement"); await relay(res, "POST", "/goal/measure", {}, LONG_TIMEOUT_MS); }));
  router.post("/agi/goal/practice", adminOnly, wrap(async (req, res) => { audit(req, "practice", "ran AGI practice suite"); await relay(res, "POST", "/goal/practice", {}, LONG_TIMEOUT_MS); }));

  // Autonomous loop controls. Field-by-field whitelist; bounds are re-checked upstream.
  router.get("/agi/schedule", adminOnly, wrap((_req, res) => relay(res, "GET", "/schedule")));
  router.put("/agi/schedule", adminOnly, wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
    const patch: Record<string, unknown> = {};
    if (b.enabled !== undefined) { if (typeof b.enabled !== "boolean") return void fail(res, 400, "'enabled' must be boolean"); patch.enabled = b.enabled; }
    if (b.everyMinutes !== undefined) { if (!int(b.everyMinutes, 5, 10_080)) return void fail(res, 400, "'everyMinutes' must be an integer 5-10080"); patch.everyMinutes = b.everyMinutes; }
    if (b.dailyTokens !== undefined) { if (!int(b.dailyTokens, 10_000, 100_000_000)) return void fail(res, 400, "'dailyTokens' must be an integer 10000-100000000"); patch.dailyTokens = b.dailyTokens; }
    if (b.reset !== undefined) { if (b.reset !== "daily" && b.reset !== "rolling") return void fail(res, 400, "'reset' must be 'daily' or 'rolling'"); patch.reset = b.reset; }
    if (b.tzOffsetMin !== undefined) { if (!int(b.tzOffsetMin, -840, 840)) return void fail(res, 400, "'tzOffsetMin' must be an integer -840..840"); patch.tzOffsetMin = b.tzOffsetMin; }
    if (Object.keys(patch).length === 0) return void fail(res, 400, "no schedule fields provided");
    audit(req, "schedule_update", "updated AGI schedule", patch);
    await relay(res, "PUT", "/schedule", patch);
  }));

  router.post("/agi/knowledge", adminOnly, wrap(async (req, res) => {
    const text = (req.body as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 4000) return void fail(res, 400, "'text' must be a non-empty string ≤4000 chars");
    audit(req, "knowledge", "added AGI knowledge fact", { length: text.length });
    await relay(res, "POST", "/knowledge", { text });
  }));

  router.post("/agi/approvals/:id/:decision", adminOnly, wrap(async (req, res) => {
    const { id, decision } = req.params;
    if (!goodId(id)) return void fail(res, 400, "Invalid approval id");
    if (decision !== "approve" && decision !== "deny") return void fail(res, 400, "Decision must be 'approve' or 'deny'");
    audit(req, `approval_${decision}`, `${decision}d AGI action ${id}`, { id });
    await relay(res, "POST", `/approvals/${id}/${decision}`, {});
  }));

  router.post("/agi/evolutions/propose", adminOnly, wrap(async (req, res) => { audit(req, "evolve_propose", "started an AGI evolution cycle"); await relay(res, "POST", "/evolutions/propose", {}); }));
  router.post("/agi/evolutions/:id/:decision", adminOnly, wrap(async (req, res) => {
    const { id, decision } = req.params;
    if (!goodId(id)) return void fail(res, 400, "Invalid evolution id");
    if (decision !== "approve" && decision !== "reject") return void fail(res, 400, "Decision must be 'approve' or 'reject'");
    audit(req, `evolve_${decision}`, `${decision}ed AGI evolution ${id}`, { id });
    await relay(res, "POST", `/evolutions/${id}/${decision}`, {});
  }));

  router.post("/agi/kill", adminOnly, wrap(async (req, res) => { audit(req, "kill", "engaged the AGI kill switch"); await relay(res, "POST", "/kill", {}); }));
  router.post("/agi/kill/reset", adminOnly, wrap(async (req, res) => { audit(req, "kill_reset", "released the AGI kill switch"); await relay(res, "POST", "/kill/reset", {}); }));

  // ─── Admin: live activity stream (SSE, proxied with the shared secret) ────────────────────
  // The browser can't attach an Authorization header to EventSource, so the UI reads this with
  // fetch() streaming — which is why it can stay behind normal bearer auth (no token in a URL).
  router.get("/agi/events", adminOnly, wrap(async (req, res) => {
    const { base, token } = cfg();
    if (!base) return void fail(res, 503, "AGI service is not configured (set XCODER_AGI_URL)");
    const { userId } = deps.getUser(req);
    if (sseTotal >= MAX_SSE_TOTAL || (sseByUser.get(userId) ?? 0) >= MAX_SSE_PER_USER) return void fail(res, 429, "Too many open activity streams");
    sseTotal++;
    sseByUser.set(userId, (sseByUser.get(userId) ?? 0) + 1);
    const ctl = new AbortController();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      sseTotal--;
      const n = (sseByUser.get(userId) ?? 1) - 1;
      if (n <= 0) sseByUser.delete(userId);
      else sseByUser.set(userId, n);
      ctl.abort();
    };
    req.on("close", release);
    try {
      const r = await doFetch(base + "/events", { headers: { accept: "text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: ctl.signal, redirect: "error" });
      if (!r.ok || !r.body) {
        release();
        return void fail(res, 502, "AGI event stream unavailable");
      }
      res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      const reader = r.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      } finally {
        reader.releaseLock?.();
      }
      res.end();
    } catch {
      if (!res.headersSent) fail(res, 502, "AGI event stream unavailable");
      else res.end();
    } finally {
      release();
    }
  }));
}
