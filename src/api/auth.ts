import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

/**
 * Token-based authentication middleware for the xcoder API.
 *
 * The system authenticates against a user store managed by routes.ts.
 * When the user table is empty, the first user to register becomes an admin.
 * There is no static admin password — all auth goes through the user store.
 */

// ─── Token Store ────────────────────────────────────────────────────────────

interface TokenEntry {
  userId: string;
  username: string;
  role: "admin" | "user";
  createdAt: string;
  /** Epoch ms after which this token is no longer valid. SECURITY: tokens previously never
   *  expired — a token issued once (or leaked once, e.g. via a logged request, an XSS bug in
   *  a future UI change, or a compromised client device) remained valid FOREVER, with no way
   *  to force it to expire short of an admin manually revoking that exact token string (which
   *  isn't even exposed anywhere). A fixed TTL bounds the blast radius of any leaked token. */
  expiresAt: number;
}

/** How long an issued token remains valid. Override with XCODER_TOKEN_TTL_MS for a shorter
 *  window in higher-security deployments. Default: 7 days. */
export const TOKEN_TTL_MS = Number(process.env.XCODER_TOKEN_TTL_MS) > 0 ? Number(process.env.XCODER_TOKEN_TTL_MS) : 7 * 24 * 60 * 60 * 1000;

const tokenStore = new Map<string, TokenEntry>();

// ─── User Store (injected by routes.ts) ─────────────────────────────────────

export interface StoredUser {
  id: string;
  username: string;
  /** Empty string for "google" accounts — they have no local password at all, so
   *  verifyPassword() can never accidentally succeed against it (an empty stored hash never
   *  parses into a valid scrypt/legacy format, so verifyPassword always returns false). */
  passwordHash: string;
  role: "admin" | "user";
  createdAt: string;
  /** "google" accounts authenticate exclusively via verifyGoogleLogin() below; "local" (the
   *  default, including every pre-existing user) authenticates via verifyLogin(). */
  authProvider: "local" | "google";
  /** Google's stable subject id ("sub" claim) for this account. Only set for authProvider
   *  "google" — this, not email, is the durable identifier Google recommends matching on. */
  googleId?: string;
  /** Email on file. Always set for "google" accounts (it's how an admin pre-links one before
   *  first login); optional for "local" accounts. */
  email?: string;
}

let userStore: StoredUser[] = [];

/**
 * Set the user store reference. Called by routes.ts on startup.
 */
export function setUserStore(store: StoredUser[]): void {
  userStore = store;
}

/**
 * Get the current user store reference.
 */
export function getUserStore(): StoredUser[] {
  return userStore;
}

// ─── Token Management ───────────────────────────────────────────────────────

/**
 * Generate a new token for a user and store it.
 * Returns the token string.
 */
export function generateToken(userId: string, username: string, role: "admin" | "user" = "user"): string {
  const token = crypto.randomUUID();
  tokenStore.set(token, {
    userId,
    username,
    role,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

/**
 * Validate a Bearer token. Returns the token entry if valid and not expired, null otherwise.
 * An expired token is also evicted from the store here (lazy cleanup on access), on top of
 * the periodic sweep further down this file.
 */
export function validateToken(token: string): TokenEntry | null {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    tokenStore.delete(token);
    return null;
  }
  return entry;
}

/**
 * Remove a token from the store (logout).
 */
export function revokeToken(token: string): boolean {
  return tokenStore.delete(token);
}

/**
 * Get all tokens for a given username (for admin user management).
 */
export function getTokensForUser(username: string): string[] {
  const tokens: string[] = [];
  for (const [token, entry] of tokenStore) {
    if (entry.username === username) {
      tokens.push(token);
    }
  }
  return tokens;
}

// ─── Password Hashing ───────────────────────────────────────────────────────
//
// Uses scrypt (via Node's built-in node:crypto — no extra dependency) rather than a single
// SHA-256 pass. SHA-256 is a fast general-purpose hash: cheap to compute means cheap to brute
// force at scale on GPUs/ASICs. scrypt is a deliberately slow, memory-hard KDF designed for
// password storage, which is what we actually want here.
//
// Format: "scrypt:N:r:p:salt:hash" so cost parameters travel with the hash and can be bumped
// later (e.g. increasing N) without invalidating already-stored hashes using the old parameters.
// Old "salt:hash" (bare SHA-256) values from before this change still verify correctly via the
// legacy path below, so existing users aren't locked out — but every successful login re-hashes
// with scrypt and the caller should persist the upgraded hash (see verifyPasswordWithUpgrade).

const SCRYPT_N = 16384; // CPU/memory cost factor (2^14) — Node's documented default
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function scryptHash(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString("hex");
}

/**
 * Hash a password using scrypt with a random salt.
 * Returns "scrypt:N:r:p:salt:hash" format.
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = scryptHash(password, salt);
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt}:${hash}`;
}

/**
 * Verify a password against a stored hash. Supports both the current scrypt format
 * ("scrypt:N:r:p:salt:hash") and the legacy bare SHA-256 format ("salt:hash") for
 * hashes created before this change.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");

  if (parts[0] === "scrypt" && parts.length === 6) {
    const [, nStr, rStr, pStr, salt, hash] = parts;
    const n = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!salt || !hash || !Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const computed = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: n, r, p }).toString("hex");
    return timingSafeEqualHex(computed, hash);
  }

  // Legacy path: bare "salt:hash" SHA-256 hashes from before scrypt was introduced.
  if (parts.length === 2) {
    const [salt, hash] = parts;
    if (!salt || !hash) return false;
    const computed = crypto.createHash("sha256").update(salt + password).digest("hex");
    return timingSafeEqualHex(computed, hash);
  }

  return false;
}

/**
 * True if a stored hash is in the legacy (pre-scrypt) format and should be upgraded
 * on next successful login.
 */
export function isLegacyHash(stored: string): boolean {
  return stored.split(":").length === 2;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Login Verification ─────────────────────────────────────────────────────

/**
 * Verify login credentials against the user store.
 * Returns the user on success, null on failure.
 */
export function verifyLogin(username: string, password: string): StoredUser | null {
  const user = userStore.find((u) => u.username === username);
  if (!user) return null;
  if (user.authProvider === "google") return null; // no local password to check
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

/**
 * Find the user linked to a verified Google identity, matching first by the durable Google
 * subject id (googleId) and falling back to email (covers a user an admin pre-created by email
 * before their first Google sign-in, which only has email on file yet).
 */
export function findGoogleUser(googleId: string, email: string): StoredUser | null {
  return (
    userStore.find((u) => u.authProvider === "google" && u.googleId === googleId) ??
    userStore.find((u) => u.authProvider === "google" && !u.googleId && u.email?.toLowerCase() === email.toLowerCase()) ??
    null
  );
}

// ─── Rate Limiting ──────────────────────────────────────────────────────────
//
// Simple in-memory sliding-window limiter. In-memory is fine for xcoder's typical
// single-process deployment; a multi-instance deployment behind a load balancer would need a
// shared store (Redis, etc.) instead — same caveat as the token store, see auth.ts's module
// doc comment and the security review notes.

interface RateLimitEntry {
  attempts: number[]; // timestamps (ms) of recent attempts within the window
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Login: password hashing alone (even scrypt) doesn't stop an attacker from just trying many
// passwords against the endpoint — this caps how many attempts a given key (IP + username)
// gets in a time window.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 10;

// Task submission (/chat, /chat/plan): SECURITY FINDING — these endpoints trigger real LLM
// calls (cost) and real ReAct/SDLC-DAG execution (CPU/memory/time on shared infrastructure),
// but previously had NO rate limiting at all. In a SaaS with multiple subscribed tenants
// sharing the same server process, one user hammering task submission is a direct
// noisy-neighbor / cost-exhaustion vector against every other tenant, not just themselves.
// Tunable independently of the login limiter since "how many tasks is reasonable per hour"
// is a very different number from "how many login attempts is reasonable per 15 minutes."
const TASK_RATE_LIMIT_WINDOW_MS = Number(process.env.XCODER_TASK_RATE_WINDOW_MS) > 0 ? Number(process.env.XCODER_TASK_RATE_WINDOW_MS) : 60 * 60 * 1000; // 1 hour
const TASK_RATE_LIMIT_MAX = Number(process.env.XCODER_TASK_RATE_MAX) > 0 ? Number(process.env.XCODER_TASK_RATE_MAX) : 30; // 30 task submissions/hour/user by default

/**
 * Records an attempt for `key` and returns whether the caller is currently rate-limited.
 * `key` should combine the identifying info that matters (e.g. `${ip}:${username}`).
 */
export function checkRateLimit(key: string): { limited: boolean; retryAfterMs?: number } {
  return checkRateLimitWithConfig(key, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_ATTEMPTS);
}

/** Same mechanism as checkRateLimit, but scoped to per-user task submission with its own
 *  window/max — always key by userId (never username or IP alone), so limits genuinely
 *  isolate one tenant's usage from another's regardless of how many accounts share an IP. */
export function checkTaskRateLimit(userId: string): { limited: boolean; retryAfterMs?: number } {
  return checkRateLimitWithConfig(`task:${userId}`, TASK_RATE_LIMIT_WINDOW_MS, TASK_RATE_LIMIT_MAX);
}

/** Rate limit for Workspace file browser mutations (PUT/POST/DELETE under /workspace/*) —
 *  deliberately a separate bucket from checkTaskRateLimit(), not a reuse of it. Task submission
 *  is capped at 30/hour by design (each one kicks off a real LLM-driven run); someone actively
 *  editing files in the Workspace page can easily exceed that in a few minutes of normal
 *  save-as-you-go work, and sharing the same bucket would mean editing files eats into the same
 *  budget as running tasks, for two very different kinds of usage. This is a much higher,
 *  shorter-window ceiling meant only to catch a runaway script or a compromised session, not to
 *  throttle normal interactive editing. */
const WORKSPACE_RATE_LIMIT_WINDOW_MS = Number(process.env.XCODER_WORKSPACE_RATE_WINDOW_MS) > 0 ? Number(process.env.XCODER_WORKSPACE_RATE_WINDOW_MS) : 5 * 60 * 1000; // 5 minutes
const WORKSPACE_RATE_LIMIT_MAX = Number(process.env.XCODER_WORKSPACE_RATE_MAX) > 0 ? Number(process.env.XCODER_WORKSPACE_RATE_MAX) : 300; // 300 writes/5min/user by default
export function checkWorkspaceRateLimit(userId: string): { limited: boolean; retryAfterMs?: number } {
  return checkRateLimitWithConfig(`workspace:${userId}`, WORKSPACE_RATE_LIMIT_WINDOW_MS, WORKSPACE_RATE_LIMIT_MAX);
}

function checkRateLimitWithConfig(key: string, windowMs: number, maxAttempts: number): { limited: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key) ?? { attempts: [] };

  // Drop attempts outside the window
  entry.attempts = entry.attempts.filter((t) => now - t < windowMs);

  if (entry.attempts.length >= maxAttempts) {
    const oldest = entry.attempts[0];
    rateLimitStore.set(key, entry);
    return { limited: true, retryAfterMs: windowMs - (now - oldest) };
  }

  entry.attempts.push(now);
  rateLimitStore.set(key, entry);
  return { limited: false };
}

/**
 * Periodically clean up stale entries so the map doesn't grow unbounded.
 *
 * Uses the LONGER of the two configured windows to decide staleness, not the login window
 * alone — this store is now shared between the login limiter (15 min window) and the task
 * limiter (1 hour window by default, see checkTaskRateLimit). An earlier version of this sweep
 * filtered every entry's attempts using only RATE_LIMIT_WINDOW_MS (the login window), which
 * would have silently trimmed still-valid task-rate-limit timestamps every 15 minutes and let
 * the per-user task limit quietly reset early — undermining the very protection it exists to
 * provide. Sweeping by "has this entry had zero activity for the longest configured window"
 * is safe for both: checkRateLimitWithConfig() always does its own correctly-scoped filtering
 * on the read path regardless of what this backstop does.
 */
const RATE_LIMIT_SWEEP_INTERVAL_MS = Math.max(RATE_LIMIT_WINDOW_MS, TASK_RATE_LIMIT_WINDOW_MS, WORKSPACE_RATE_LIMIT_WINDOW_MS);
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    const mostRecent = entry.attempts[entry.attempts.length - 1] ?? 0;
    if (now - mostRecent >= RATE_LIMIT_SWEEP_INTERVAL_MS) rateLimitStore.delete(key);
  }
}, RATE_LIMIT_SWEEP_INTERVAL_MS).unref();

/** Periodically evict expired tokens so the token store doesn't grow unbounded on a
 *  long-running server. validateToken() also lazily evicts on access; this is the backstop
 *  for tokens that expire without ever being presented again. */
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenStore) {
    if (now >= entry.expiresAt) tokenStore.delete(token);
  }
}, 60 * 60 * 1000).unref();

// ─── Express Middleware ─────────────────────────────────────────────────────

/**
 * Express middleware that validates the Authorization header.
 *
 * Requires a valid Bearer token from the token store for all routes
 * except /login and /register.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for login and register endpoints
  if ((req.path === "/login" && req.method === "POST") ||
      (req.path === "/register" && req.method === "POST") ||
      (req.path === "/auth/google" && req.method === "POST") ||
      (req.path === "/users/count" && req.method === "GET")) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header) {
    res.status(401).json({ success: false, error: "Missing Authorization header" });
    return;
  }

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    res.status(401).json({ success: false, error: "Authorization header must be: Bearer <token>" });
    return;
  }

  const token = parts[1];
  const entry = validateToken(token);
  if (!entry) {
    res.status(403).json({ success: false, error: "Invalid or expired API token" });
    return;
  }

  // Attach user info to request for downstream use
  (req as any).user = entry;

  next();
}

/**
 * Requires the authenticated caller (authMiddleware must run first) to have the "admin" role.
 * Every route that manages other users' accounts (GET/POST/PUT/DELETE /users) or platform-wide
 * secrets (PUT/DELETE /settings/llm-key) MUST be wrapped with this — those routes previously
 * had NO role check at all (only authMiddleware's "is this a valid token" check), which meant
 * any regular authenticated user could PUT their own user id with {role: "admin"} for instant
 * self-privilege-escalation, enumerate every account on the platform, delete other users, or
 * overwrite/delete the single platform-wide LLM API key used by every tenant. This is the fix
 * for that finding — see the security review notes for the full writeup.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as { user?: TokenEntry }).user;
  if (!user || user.role !== "admin") {
    res.status(403).json({ success: false, error: "Admin privileges required" });
    return;
  }
  next();
}


