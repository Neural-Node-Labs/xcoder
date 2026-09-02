import { describe, it, expect, vi, beforeEach } from "vitest";

describe("token expiration (security fix — tokens previously never expired)", () => {
  it("a freshly generated token validates successfully", async () => {
    vi.resetModules();
    const auth = await import("../auth.js");
    const token = auth.generateToken("user-1", "alice", "user");
    expect(auth.validateToken(token)).not.toBeNull();
  });

  it("an expired token is rejected by validateToken and evicted from the store", async () => {
    vi.resetModules();
    process.env.XCODER_TOKEN_TTL_MS = "50"; // 50ms TTL for a fast test
    const auth = await import("../auth.js");
    const token = auth.generateToken("user-1", "alice", "user");
    expect(auth.validateToken(token)).not.toBeNull();

    await new Promise((r) => setTimeout(r, 80));

    expect(auth.validateToken(token)).toBeNull();
    delete process.env.XCODER_TOKEN_TTL_MS;
  });

  it("authMiddleware rejects an expired token with 403, not treating it as valid", async () => {
    vi.resetModules();
    process.env.XCODER_TOKEN_TTL_MS = "50";
    const auth = await import("../auth.js");
    const token = auth.generateToken("user-1", "alice", "user");
    await new Promise((r) => setTimeout(r, 80));

    const req: any = { path: "/chat", headers: { authorization: `Bearer ${token}` } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    auth.authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    delete process.env.XCODER_TOKEN_TTL_MS;
  });
});

describe("requireAdmin (security fix — /users and /settings/llm-key had NO role check at all)", () => {
  it("rejects a request with no authenticated user attached", async () => {
    vi.resetModules();
    const auth = await import("../auth.js");
    const req: any = {};
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    auth.requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a regular 'user'-role caller — this is the exact privilege-escalation gap that was fixed", async () => {
    vi.resetModules();
    const auth = await import("../auth.js");
    const req: any = { user: { userId: "u1", username: "alice", role: "user" } };
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    auth.requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows an 'admin'-role caller through", async () => {
    vi.resetModules();
    const auth = await import("../auth.js");
    const req: any = { user: { userId: "u1", username: "admin", role: "admin" } };
    const res: any = { status: vi.fn(), json: vi.fn() };
    const next = vi.fn();

    auth.requireAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("per-user task rate limiting (security fix — /chat and /chat/plan had NO rate limiting at all)", () => {
  it("allows task submissions under the configured limit", async () => {
    vi.resetModules();
    process.env.XCODER_TASK_RATE_MAX = "3";
    process.env.XCODER_TASK_RATE_WINDOW_MS = "60000";
    const auth = await import("../auth.js");

    expect(auth.checkTaskRateLimit("user-a").limited).toBe(false);
    expect(auth.checkTaskRateLimit("user-a").limited).toBe(false);
    expect(auth.checkTaskRateLimit("user-a").limited).toBe(false);

    delete process.env.XCODER_TASK_RATE_MAX;
    delete process.env.XCODER_TASK_RATE_WINDOW_MS;
  });

  it("blocks task submissions once the per-user limit is exceeded", async () => {
    vi.resetModules();
    process.env.XCODER_TASK_RATE_MAX = "2";
    process.env.XCODER_TASK_RATE_WINDOW_MS = "60000";
    const auth = await import("../auth.js");

    auth.checkTaskRateLimit("user-b");
    auth.checkTaskRateLimit("user-b");
    const third = auth.checkTaskRateLimit("user-b");

    expect(third.limited).toBe(true);
    expect(third.retryAfterMs).toBeGreaterThan(0);

    delete process.env.XCODER_TASK_RATE_MAX;
    delete process.env.XCODER_TASK_RATE_WINDOW_MS;
  });

  it("one user hitting their limit does NOT affect a different user's ability to submit tasks", async () => {
    vi.resetModules();
    process.env.XCODER_TASK_RATE_MAX = "1";
    process.env.XCODER_TASK_RATE_WINDOW_MS = "60000";
    const auth = await import("../auth.js");

    auth.checkTaskRateLimit("noisy-user");
    const noisyBlocked = auth.checkTaskRateLimit("noisy-user");
    const quietUser = auth.checkTaskRateLimit("quiet-user");

    expect(noisyBlocked.limited).toBe(true);
    expect(quietUser.limited).toBe(false); // a completely separate counter, per userId

    delete process.env.XCODER_TASK_RATE_MAX;
    delete process.env.XCODER_TASK_RATE_WINDOW_MS;
  });

  it("the login rate limiter and the task rate limiter use independent windows/limits", async () => {
    vi.resetModules();
    const auth = await import("../auth.js");
    // Exhaust the (much stricter, 10/15min) login limiter for a key...
    for (let i = 0; i < 10; i++) auth.checkRateLimit("1.2.3.4:alice");
    expect(auth.checkRateLimit("1.2.3.4:alice").limited).toBe(true);
    // ...and confirm that has zero effect on a same-named user's task rate limit.
    expect(auth.checkTaskRateLimit("alice").limited).toBe(false);
  });
});
