/**
 * Shared plumbing for every provider in this server: config resolution, a small fetch wrapper
 * with consistent error shaping, and Google's OAuth refresh-token exchange (shared by Gmail,
 * Drive and Calendar, which are three APIs behind one set of credentials).
 *
 * Design notes worth knowing before extending this:
 *
 * - **No credentials are ever accepted as tool arguments.** Everything comes from the
 *   environment. An MCP server's tool arguments are chosen by a model, and a model that can be
 *   talked into passing an attacker's token is a credential-exfiltration path. Keeping auth
 *   entirely out of the tool surface removes that class of problem: the worst a prompt-injected
 *   model can do here is call the tools it was already given, as the user it was already
 *   configured as.
 * - **Every provider is optional.** Missing env vars disable that provider's tools rather than
 *   crashing the server, so you can run this with only Telegram configured and the Google tools
 *   simply won't be listed. `describeConfig()` reports what's active.
 * - **No SDK clients (googleapis, octokit, etc.)** — these are thin REST calls. It keeps the
 *   dependency surface to one package (the MCP SDK itself), which matters for something holding
 *   this many live credentials.
 */

export class ToolError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Reads an env var, or throws a ToolError naming exactly what's missing and how to get it. */
export function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new ToolError(`${name} is not set.`, hint);
  return value;
}

export function hasEnv(...names: string[]): boolean {
  return names.every((n) => !!process.env[n]);
}

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Send body as form-urlencoded instead of JSON (Google's token endpoint wants this). */
  form?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * fetch() with a timeout, JSON encode/decode, and errors that carry the provider's own message
 * instead of a bare "500". Most API failures here are actionable (expired token, missing scope,
 * bad chat id) and that detail is the whole value — swallowing it would make every failure look
 * the same to the caller.
 */
export async function apiFetch<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { method = "GET", headers = {}, body, form, timeoutMs = 20_000 } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let payload: string | undefined;
  const finalHeaders: Record<string, string> = { Accept: "application/json", ...headers };

  if (form) {
    payload = new URLSearchParams(form).toString();
    finalHeaders["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    finalHeaders["Content-Type"] = "application/json";
  }

  try {
    const res = await fetch(url, { method, headers: finalHeaders, body: payload, signal: controller.signal });
    const text = await res.text();

    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* non-JSON response (some Drive endpoints return raw content) — keep the raw text */
      }
    }

    if (!res.ok) {
      const detail = extractApiError(parsed) ?? text.slice(0, 500) ?? res.statusText;
      throw new ToolError(`${method} ${redactUrl(url)} failed (${res.status}): ${detail}`);
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new ToolError(`${method} ${redactUrl(url)} timed out after ${timeoutMs}ms.`);
    }
    throw new ToolError(`${method} ${redactUrl(url)} failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Pulls the human-readable message out of whichever error envelope the provider uses. */
function extractApiError(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const o = parsed as Record<string, any>;
  // Google: { error: { message } } or { error, error_description }
  if (typeof o.error === "object" && o.error?.message) return String(o.error.message);
  if (typeof o.error === "string") return String(o.error_description ?? o.error);
  // GitHub: { message }
  if (typeof o.message === "string") return o.message;
  // Telegram: { description }
  if (typeof o.description === "string") return o.description;
  return undefined;
}

/** Telegram puts the bot token in the URL path — never let it reach a log or an error string. */
function redactUrl(url: string): string {
  return url.replace(/\/bot\d+:[\w-]+/g, "/bot<redacted>");
}

// ─── Google OAuth (shared by Gmail, Drive, Calendar) ────────────────────────

let cachedGoogleToken: { token: string; expiresAt: number } | null = null;

/**
 * Exchanges the long-lived refresh token for a short-lived access token, cached in memory until
 * shortly before it expires.
 *
 * Note on the cache: xcoder's own MCP client spawns a fresh process per call (see
 * src/tools/mcpTool.ts), so under that client this cache never actually gets reused — every call
 * pays one extra token round-trip. It's kept because this server is a normal MCP server usable
 * by any client, and long-lived clients (Claude Desktop, an HTTP wrapper) do reuse the process,
 * where it saves a request per tool call.
 */
export async function googleAccessToken(): Promise<string> {
  if (cachedGoogleToken && Date.now() < cachedGoogleToken.expiresAt) return cachedGoogleToken.token;

  const hint =
    "Create an OAuth client (Desktop app) in Google Cloud Console, enable the Gmail/Drive/Calendar APIs, " +
    "then run through the consent flow once to obtain a refresh token. See README.md for the exact steps.";

  const clientId = requireEnv("GOOGLE_CLIENT_ID", hint);
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET", hint);
  const refreshToken = requireEnv("GOOGLE_REFRESH_TOKEN", hint);

  const res = await apiFetch<{ access_token: string; expires_in: number }>(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      form: {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      },
    }
  );

  // Refresh a minute early so a token never expires mid-request.
  cachedGoogleToken = { token: res.access_token, expiresAt: Date.now() + (res.expires_in - 60) * 1000 };
  return res.access_token;
}

export async function googleFetch<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const token = await googleAccessToken();
  return apiFetch<T>(url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
}

// ─── Provider availability ──────────────────────────────────────────────────

export const providers = {
  google: () => hasEnv("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"),
  github: () => hasEnv("GITHUB_TOKEN"),
  telegram: () => hasEnv("TELEGRAM_BOT_TOKEN"),
  whatsapp: () => hasEnv("WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"),
};

export function describeConfig(): string {
  const rows = [
    ["Gmail / Drive / Calendar", providers.google(), "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN"],
    ["GitHub", providers.github(), "GITHUB_TOKEN"],
    ["Telegram", providers.telegram(), "TELEGRAM_BOT_TOKEN"],
    ["WhatsApp", providers.whatsapp(), "WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID"],
  ] as const;

  return rows
    .map(([name, active, envs]) => `${active ? "✓" : "✗"} ${name}${active ? "" : `  — set ${envs}`}`)
    .join("\n");
}

/** Truncates long API payloads so a single tool result can't blow up a model's context. */
export function truncate(text: string, max = 8000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} more characters]`;
}
