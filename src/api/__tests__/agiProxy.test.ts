import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { registerAgiRoutes } from "../agiProxy.js";

interface Seen { method: string; url: string; auth?: string; cookie?: string; body: any }
let seen: Seen[] = [];
let upstreamStatus: Record<string, { status: number; body: unknown }> = {};

let upstream: http.Server;
let upstreamBase = "";
let app: http.Server;
let appBase = "";
const audits: string[] = [];
let limited = false;

function startUpstream(): Promise<void> {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, cookie: req.headers.cookie as string | undefined, body: raw ? JSON.parse(raw) : undefined });
      if (req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"kind":"span","id":"a","name":"agi.run","phase":"start","t":1}\n\n');
        setTimeout(() => res.write('data: {"kind":"goal"}\n\n'), 20);
        setTimeout(() => res.end(), 60);
        return;
      }
      const o = upstreamStatus[`${req.method} ${req.url}`] ?? { status: 200, body: { ok: true, echo: raw ? JSON.parse(raw) : null } };
      res.writeHead(o.status, { "content-type": "application/json" });
      res.end(JSON.stringify(o.body));
    });
  });
  return new Promise((r) => upstream.listen(0, "127.0.0.1", () => { upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`; r(); }));
}

function startApp(env: NodeJS.ProcessEnv): Promise<void> {
  const a = express();
  a.use(express.json());
  // Stand-in for authMiddleware: identity comes from test headers.
  a.use((req, _res, next) => {
    const role = req.header("x-test-role");
    if (role) (req as any).user = { userId: req.header("x-test-user") ?? "7", username: "t", role };
    next();
  });
  const router = express.Router();
  registerAgiRoutes(router, {
    getUser: (req) => ({ userId: (req as any).user?.userId ?? "", isAdmin: (req as any).user?.role === "admin" }),
    checkTaskRateLimit: () => (limited ? { limited: true, retryAfterMs: 5000 } : { limited: false }),
    audit: (_req, action) => audits.push(action),
    env,
  });
  a.use("/api/v1", router);
  app = http.createServer(a);
  return new Promise((r) => app.listen(0, "127.0.0.1", () => { appBase = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/v1`; r(); }));
}

const call = (method: string, path: string, role: "admin" | "user" | null, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(appBase + path, { method, headers: { "content-type": "application/json", ...(role ? { "x-test-role": role } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), headers: r.headers }));

beforeAll(async () => {
  await startUpstream();
  await startApp({ XCODER_AGI_URL: upstreamBase, XCODER_AGI_TOKEN: "shared-secret" });
});
afterAll(() => { upstream.closeAllConnections?.(); upstream.close(); app.closeAllConnections?.(); app.close(); });
beforeEach(() => { seen = []; upstreamStatus = {}; audits.length = 0; limited = false; });

describe("AGI gateway — authorisation by role", () => {
  const userAllowed: Array<[string, string, unknown?]> = [["GET", "/agi/status"], ["GET", "/agi/goal"], ["GET", "/agi/skills"], ["POST", "/agi/chat", { message: "hi" }]];
  const adminOnly: Array<[string, string, unknown?]> = [
    ["GET", "/agi/recent"], ["GET", "/agi/approvals"], ["GET", "/agi/evolutions"], ["GET", "/agi/events"],
    ["PUT", "/agi/goal", { autonomy: 1 }], ["POST", "/agi/goal/measure"], ["POST", "/agi/goal/practice"], ["POST", "/agi/knowledge", { text: "x" }],
    ["POST", "/agi/approvals/abc123/approve"], ["POST", "/agi/evolutions/propose"], ["POST", "/agi/evolutions/abc123/approve"], ["POST", "/agi/kill"], ["POST", "/agi/kill/reset"], ["GET", "/agi/schedule"], ["PUT", "/agi/schedule", { enabled: true }],
  ];
  it.each(userAllowed)("%s %s is open to a normal user", async (m, p, b) => {
    const r = await call(m, p, "user", b ?? (m === "POST" ? {} : undefined));
    expect(r.status).toBe(200);
  });
  it.each(adminOnly)("%s %s is forbidden to a normal user and never reaches AGI", async (m, p, b) => {
    const r = await call(m, p, "user", b ?? (m === "POST" ? {} : undefined));
    expect(r.status).toBe(403);
    expect(seen).toEqual([]);
  });
  it.each(adminOnly.filter(([, p]) => p !== "/agi/events"))("%s %s works for an admin", async (m, p, b) => {
    const r = await call(m, p, "admin", b ?? (m === "POST" ? {} : undefined));
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
  });
});

describe("AGI gateway — secrets and what is forwarded", () => {
  it("sends the shared secret upstream and never the user's own credentials/cookies", async () => {
    await call("GET", "/agi/goal", "admin", undefined, { authorization: "Bearer USER-TOKEN", cookie: "xcoder_session=abc" });
    expect(seen[0].auth).toBe("Bearer shared-secret");
    expect(seen[0].cookie).toBeUndefined();
  });
  it("derives the AGI session from the authenticated user, ignoring a client-supplied session", async () => {
    await call("POST", "/agi/chat", "user", { message: "hi", session: "victim" }, { "x-test-user": "42" });
    expect(seen[0].body.session).toBe("u42");
    expect(JSON.stringify(seen[0].body)).not.toContain("victim");
  });
  it("forwards only whitelisted goal fields (no kpi/constraint injection)", async () => {
    await call("PUT", "/agi/goal", "admin", { statement: "new goal", autonomy: 2, kpis: [{ name: "x", target: 0 }], constraints: [] });
    expect(seen[0].body).toEqual({ statement: "new goal", autonomy: 2 });
  });
  it("forwards only whitelisted schedule fields and audits the change", async () => {
    await call("PUT", "/agi/schedule", "admin", { enabled: true, dailyTokens: 50000, reset: "daily", tzOffsetMin: 480, evil: "x" });
    expect(seen[0].body).toEqual({ enabled: true, dailyTokens: 50000, reset: "daily", tzOffsetMin: 480 });
    expect(audits).toContain("agi.schedule_update");
  });
  it.each([[{ dailyTokens: 5 }], [{ everyMinutes: 1 }], [{ reset: "weekly" }], [{ enabled: "yes" }], [{ tzOffsetMin: 99999 }], [{}]])("rejects bad schedule %j", async (b) => {
    const r = await call("PUT", "/agi/schedule", "admin", b);
    expect(r.status).toBe(400); expect(seen).toEqual([]);
  });
  it("audits admin mutations", async () => {
    await call("POST", "/agi/kill", "admin", {});
    await call("POST", "/agi/evolutions/abc123/approve", "admin", {});
    expect(audits).toEqual(["agi.kill", "agi.evolve_approve"]);
  });
});

describe("AGI gateway — validation", () => {
  it.each([
    [{}, "message"], [{ message: "   " }, "message"], [{ message: "x".repeat(4001) }, "4000"], [{ message: 5 }, "message"],
    [{ message: "hi", history: "nope" }, "history"], [{ message: "hi", history: new Array(13).fill({ role: "user", text: "a" }) }, "12"],
    [{ message: "hi", history: [{ role: "system", text: "a" }] }, "history"], [{ message: "hi", history: [{ role: "user", text: 1 }] }, "history"],
  ])("rejects bad chat body %#", async (body, frag) => {
    const r = await call("POST", "/agi/chat", "user", body);
    expect(r.status).toBe(400);
    expect(r.json.error).toContain(frag);
    expect(seen).toEqual([]);
  });
  it("rejects path-traversal-ish ids and unknown decisions", async () => {
    expect((await call("POST", "/agi/approvals/..%2F..%2Fkill/approve", "admin", {})).status).toBe(400);
    expect((await call("POST", "/agi/approvals/abc/maybe", "admin", {})).status).toBe(400);
    expect((await call("POST", "/agi/evolutions/abc/approve%20x", "admin", {})).status).toBe(400);
    expect((await call("POST", "/agi/evolutions/abc123/delete", "admin", {})).status).toBe(400);
    expect(seen).toEqual([]);
  });
  it("validates goal and knowledge bodies", async () => {
    expect((await call("PUT", "/agi/goal", "admin", { autonomy: 9 })).status).toBe(400);
    expect((await call("PUT", "/agi/goal", "admin", { autonomy: "1" })).status).toBe(400);
    expect((await call("PUT", "/agi/goal", "admin", { statement: "" })).status).toBe(400);
    expect((await call("POST", "/agi/knowledge", "admin", { text: "x".repeat(4001) })).status).toBe(400);
  });
  it("applies the per-user task rate limit to chat", async () => {
    limited = true;
    const r = await call("POST", "/agi/chat", "user", { message: "hi" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("5");
    expect(seen).toEqual([]);
  });
});

describe("AGI gateway — upstream behaviour", () => {
  it("passes through upstream 4xx meaning (kill switch 423, busy 409) in xcoder's envelope", async () => {
    upstreamStatus["POST /chat"] = { status: 423, body: { error: "kill switch engaged" } };
    const r = await call("POST", "/agi/chat", "user", { message: "hi" });
    expect(r.status).toBe(423);
    expect(r.json).toEqual({ success: false, error: "kill switch engaged" });
    upstreamStatus["POST /evolutions/propose"] = { status: 409, body: { error: "already running" } };
    expect((await call("POST", "/agi/evolutions/propose", "admin", {})).status).toBe(409);
  });
  it("hides upstream 5xx internals behind a 502", async () => {
    upstreamStatus["GET /skills"] = { status: 500, body: { error: "TypeError at /app/dist/src/memory.js:12 secret=abc" } };
    const r = await call("GET", "/agi/skills", "user");
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).not.toContain("memory.js");
  });
  it("status reports reachable + role, and degrades (not errors) when AGI is down", async () => {
    upstreamStatus["GET /status"] = { status: 200, body: { release: "v1", killed: false } };
    const up = await call("GET", "/agi/status", "admin");
    expect(up.json.data).toMatchObject({ configured: true, reachable: true, isAdmin: true, release: "v1" });
    upstreamStatus["GET /status"] = { status: 500, body: { error: "boom" } };
    const down = await call("GET", "/agi/status", "user");
    expect(down.status).toBe(200);
    expect(down.json.data).toMatchObject({ configured: true, reachable: false, isAdmin: false });
  });
  it("streams SSE through to an admin", async () => {
    const r = await fetch(appBase + "/agi/events", { headers: { "x-test-role": "admin" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("x-accel-buffering")).toBe("no");
    const text = await r.text();
    expect(text).toContain('"name":"agi.run"');
    expect(text).toContain('"kind":"goal"');
    expect(seen.find((s) => s.url === "/events")?.auth).toBe("Bearer shared-secret");
  });
  it("caps concurrent activity streams per user", async () => {
    const ctls = [0, 1, 2].map(() => new AbortController());
    // slow upstream isn't needed: streams last ~60ms; open 3 and try a 4th immediately
    const open = ctls.map((c) => fetch(appBase + "/agi/events", { headers: { "x-test-role": "admin", "x-test-user": "cap" }, signal: c.signal }));
    await new Promise((r) => setTimeout(r, 10));
    const fourth = await fetch(appBase + "/agi/events", { headers: { "x-test-role": "admin", "x-test-user": "cap" } });
    expect(fourth.status).toBe(429);
    await Promise.all(open.map((p) => p.then((r) => r.text()).catch(() => {})));
  });
});

describe("AGI gateway — not configured / misconfigured", () => {
  it("is cleanly 'off' without XCODER_AGI_URL", async () => {
    const saved = app;
    await startApp({});
    const st = await call("GET", "/agi/status", "user");
    expect(st.json.data).toEqual({ configured: false, isAdmin: false });
    expect((await call("GET", "/agi/goal", "user")).status).toBe(503);
    expect((await call("GET", "/agi/events", "admin")).status).toBe(503);
    app.close(); app = saved;
    appBase = ""; await startApp({ XCODER_AGI_URL: upstreamBase, XCODER_AGI_TOKEN: "shared-secret" });
  });
  it("reports unreachable (not a crash) when the configured host is down, and ignores non-http URLs", async () => {
    await startApp({ XCODER_AGI_URL: "http://127.0.0.1:1" });
    const st = await call("GET", "/agi/status", "user");
    expect(st.json.data).toMatchObject({ configured: true, reachable: false });
    expect((await call("GET", "/agi/goal", "user")).status).toBe(502);
    await startApp({ XCODER_AGI_URL: "file:///etc/passwd" });
    expect((await call("GET", "/agi/status", "user")).json.data.configured).toBe(false);
    await startApp({ XCODER_AGI_URL: upstreamBase, XCODER_AGI_TOKEN: "shared-secret" });
  });
});
