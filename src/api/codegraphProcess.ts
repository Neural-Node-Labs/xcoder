/**
 * Manages xcoder's connection to CodeGraph, in whichever of two real deployment shapes is
 * actually in play:
 *
 * - **Bundled/spawned** (local dev, `npm run serve`): integrations/codegraph/ ships inside the
 *   repo checkout, so xcoder spawns the API server itself as a child process — see
 *   startBundledCodegraph() below. This is what a local checkout gets with zero infra setup.
 *
 * - **Sibling Docker services** (docker-compose.yml's `codegraph-api` / `codegraph-mcp`
 *   services): xcoder's own `api` container's image never copies integrations/ in and has no
 *   Python runtime (see the root Dockerfile) — spawning locally is impossible there by
 *   construction, not just by choice. Instead, `codegraph-api` and `codegraph-mcp` run as their
 *   own containers, and xcoder connects to them over the compose network — see
 *   connectExternalCodegraph() and autoConnectFromEnv() below for the API side, and
 *   resolveBundledMcpLaunch()'s "http" branch for the MCP side (network streamable-http instead
 *   of a local stdio spawn).
 *
 * Either way, CodeGraph seeds its own local admin user on first boot (see
 * codegraph/app/db.py's seed_admin_if_missing) with a password we control but don't know its
 * generated API key ahead of time — so both paths converge on the same real step: wait for the
 * server to come up, log in as that admin over HTTP, and use the api_key from the response to
 * configure codegraphKeyStore. The manual "paste in a URL + API key for an instance I'm running
 * myself" path (codegraphKeyStore.setCodegraphConnection() via the Platform > Tools UI) remains
 * available as a fallback for either deployment shape.
 */

import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { setCodegraphConnection, clearCodegraphConnection, getCodegraphConnection } from "./codegraphKeyStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** integrations/codegraph, relative to this file's location (src/api → dist/api at build time).
 *  Present in a full repo checkout / local dev; absent in the `api` Docker image (see root
 *  Dockerfile's `COPY src ./src` — integrations/ is deliberately not copied in there). */
export const CODEGRAPH_ROOT = path.join(__dirname, "..", "..", "integrations", "codegraph");
export const CODEGRAPH_API_DIR = path.join(CODEGRAPH_ROOT, "codegraph");
export const CODEGRAPH_MCP_SERVER = path.join(CODEGRAPH_ROOT, "codegraph-mcp", "server.py");
export const CODEGRAPH_UI_DIST = path.join(CODEGRAPH_ROOT, "codegraph-ui", "dist");

const DATA_DIR = process.env.XCODER_CODEGRAPH_DATA_DIR || path.join(os.homedir(), ".xcoder", "codegraph");
const CREDENTIALS_PATH = path.join(DATA_DIR, "admin_credentials.json");
const DEFAULT_PORT = parseInt(process.env.XCODER_CODEGRAPH_PORT || "8877", 10);

interface AdminCredentials {
  password: string;
  secretKey: string;
}

interface SsoSession {
  token: string;
  user: { id: number; username: string; role: string; api_key: string };
}

interface RunningState {
  /** Present only for a locally-spawned instance; absent for an externally-connected one (a
   *  sibling Docker service) — there's no local process for xcoder to own/kill in that case. */
  child: ChildProcess | null;
  baseUrl: string;
  startedAt: string;
  /** Admin session, refreshed on every (re)connect; used only for the embedded-UI SSO bridge —
   *  API calls from tools go through the API key in codegraphKeyStore instead. */
  sso: SsoSession | null;
}

let state: RunningState | null = null;

function loadOrCreateAdminCredentials(): AdminCredentials {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(CREDENTIALS_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
    } catch {
      // fall through and regenerate — a corrupt file shouldn't block startup
    }
  }
  const creds: AdminCredentials = {
    password: crypto.randomBytes(18).toString("base64url"),
    secretKey: crypto.randomBytes(32).toString("hex"),
  };
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  return creds;
}

function resolvePythonExecutable(): string {
  if (process.env.XCODER_CODEGRAPH_PYTHON) return process.env.XCODER_CODEGRAPH_PYTHON;
  // Prefer a dedicated virtualenv under the bundled dir if `npm run codegraph:install` (see
  // package.json) has been run to set one up — keeps CodeGraph's pinned FastAPI/uvicorn
  // versions isolated from whatever else is on the host's PATH.
  const venvPython = path.join(CODEGRAPH_API_DIR, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === "win32" ? "python" : "python3";
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + "/", { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`CodeGraph at ${baseUrl} didn't become healthy within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function loginAsAdmin(baseUrl: string, password: string): Promise<SsoSession> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  if (!res.ok) {
    throw new Error(
      `CodeGraph admin login to ${baseUrl} failed (${res.status}). If credentials were regenerated after its data dir was already initialized, the two are now out of sync — reset the data dir (for a spawned instance: delete ${DATA_DIR}; for a Docker volume: recreate it) so both start fresh together.`
    );
  }
  const session = (await res.json()) as SsoSession;
  if (!session?.user?.api_key) throw new Error(`CodeGraph admin login to ${baseUrl} returned no session.`);
  return session;
}

export interface CodegraphStatus {
  /** Whether integrations/codegraph/'s source is present in this build at all — false in the
   *  `api` Docker image, true in a full repo checkout. Governs whether "Start bundled
   *  CodeGraph" (a local spawn) is even offered; sibling-Docker-service connections work either
   *  way since they don't need the source to be present locally. */
  bundled: boolean;
  running: boolean;
  /** True when connected to a sibling service (e.g. docker-compose's `codegraph-api`) rather
   *  than a process xcoder spawned itself — there's no local process to stop in that case. */
  external: boolean;
  baseUrl?: string;
  startedAt?: string;
  uiAvailable: boolean; // whether codegraph-ui/dist has been built
  /** True while xcoder is still trying to reach the sibling service named by
   *  XCODER_CODEGRAPH_URL (docker-compose's `codegraph-api`). Lets the UI show "connecting…"
   *  instead of a dead-end "not connected" message during the first minute after `up`. */
  connecting: boolean;
  /** Set when a background connect to XCODER_CODEGRAPH_URL has failed; cleared on success. */
  connectError?: string;
  /** XCODER_CODEGRAPH_URL, when both it and the admin password are configured — i.e. when a
   *  sibling-service connection is expected on this deployment and "Connect" is meaningful. */
  configuredUrl?: string;
}

/** Progress of the env-driven (docker-compose) connection attempt — see autoConnectFromEnv(). */
let autoConnect: { inFlight: boolean; lastAttemptAt: number; error?: string } = { inFlight: false, lastAttemptAt: 0 };

function envConnectConfig(): { baseUrl: string; adminPassword: string } | null {
  const baseUrl = process.env.XCODER_CODEGRAPH_URL;
  const adminPassword = process.env.XCODER_CODEGRAPH_ADMIN_PASSWORD;
  if (!baseUrl || !adminPassword || process.env.XCODER_CODEGRAPH_API_KEY) return null;
  return { baseUrl, adminPassword };
}

export function isBundleAvailable(): boolean {
  return fs.existsSync(path.join(CODEGRAPH_API_DIR, "app", "api.py"));
}

export function getStatus(): CodegraphStatus {
  return {
    bundled: isBundleAvailable(),
    running: state !== null,
    external: state !== null && state.child === null,
    baseUrl: state?.baseUrl,
    startedAt: state?.startedAt,
    uiAvailable: fs.existsSync(path.join(CODEGRAPH_UI_DIST, "index.html")),
    connecting: state === null && autoConnect.inFlight,
    connectError: state === null ? autoConnect.error : undefined,
    configuredUrl: envConnectConfig()?.baseUrl,
  };
}

/** Start the bundled CodeGraph API server if it isn't already running, and point
 *  codegraphKeyStore at it. Idempotent — calling this while already running just returns the
 *  existing status. Only meaningful where integrations/codegraph/'s source is actually present
 *  (see CodegraphStatus.bundled) — e.g. not inside xcoder's own `api` Docker image. */
export async function startBundledCodegraph(): Promise<CodegraphStatus> {
  if (state) return getStatus();
  if (!isBundleAvailable()) {
    // Docker deployment: there's no local source to spawn, but a sibling `codegraph-api` service
    // may be configured via env. "Start" then means "(re)connect to it now" — this is what the
    // Explorer page's button does when the background auto-connect hasn't succeeded (yet).
    const env = envConnectConfig();
    if (env) return connectExternalCodegraph(env.baseUrl, env.adminPassword, 20_000);
    throw new Error(
      `CodeGraph source not found under ${CODEGRAPH_API_DIR}. This build wasn't packaged with integrations/codegraph/ — ` +
        `if you're running xcoder via docker-compose, use the codegraph-api/codegraph-mcp services instead (they connect automatically when XCODER_CODEGRAPH_URL is set).`
    );
  }

  const creds = loadOrCreateAdminCredentials();
  const port = DEFAULT_PORT;
  const baseUrl = `http://127.0.0.1:${port}`;
  const projectsRoot = path.join(DATA_DIR, "projects");
  fs.mkdirSync(projectsRoot, { recursive: true });

  const python = resolvePythonExecutable();
  const dbPath = path.join(DATA_DIR, "graph.db");
  const child = spawn(python, ["-m", "uvicorn", "app.api:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: CODEGRAPH_API_DIR,
    env: {
      ...process.env,
      PROJECTS_ROOT: projectsRoot,
      // CodeGraph's own default (CODEGRAPH_DB unset) is the fixed path /data/graph.db, meant
      // for its Docker image where /data is a dedicated volume. Outside Docker that's a global,
      // shared-across-every-caller path — pin it inside this xcoder install's own data dir so
      // multiple xcoder instances (or a leftover /data/graph.db from something else on the
      // host) can never collide with or shadow each other's graph data or admin credentials.
      CODEGRAPH_DB: dbPath,
      CODEGRAPH_SECRET_KEY: creds.secretKey,
      ADMIN_PASSWORD: creds.password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let startupLog = "";
  child.stdout?.on("data", (c) => { startupLog += c.toString(); });
  child.stderr?.on("data", (c) => { startupLog += c.toString(); });

  child.on("exit", (code) => {
    console.log(`[codegraph] bundled server exited (code ${code})`);
    state = null;
    clearCodegraphConnection();
  });

  try {
    await waitForHealth(baseUrl, 20_000);
    const sso = await loginAsAdmin(baseUrl, creds.password);
    state = { child, baseUrl, startedAt: new Date().toISOString(), sso };
    setCodegraphConnection({ baseUrl, apiKey: sso.user.api_key });
    return getStatus();
  } catch (err) {
    child.kill();
    state = null;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to start bundled CodeGraph: ${message}${startupLog ? `\n--- server output ---\n${startupLog.slice(-1500)}` : ""}`);
  }
}

/**
 * Connect to a CodeGraph instance xcoder does NOT own the process for — the docker-compose
 * `codegraph-api` service, or any other already-running instance an admin controls the admin
 * password for. Same real login-and-fetch-key flow as startBundledCodegraph(), just against a
 * given baseUrl instead of a freshly spawned one, and with no child process to track or kill.
 */
export async function connectExternalCodegraph(baseUrl: string, adminPassword: string, healthTimeoutMs = 60_000): Promise<CodegraphStatus> {
  const normalized = baseUrl.replace(/\/+$/, "");
  await waitForHealth(normalized, healthTimeoutMs);
  const sso = await loginAsAdmin(normalized, adminPassword);
  state = { child: null, baseUrl: normalized, startedAt: new Date().toISOString(), sso };
  setCodegraphConnection({ baseUrl: normalized, apiKey: sso.user.api_key });
  return getStatus();
}

/**
 * Called once at server startup (see server.ts). If XCODER_CODEGRAPH_URL and
 * XCODER_CODEGRAPH_ADMIN_PASSWORD are both set — the shape docker-compose.yml wires up for the
 * `codegraph-api` service — connect automatically, the same way the bundled-spawn path
 * auto-connects after starting its own process. Retries for a while since compose's
 * `depends_on: condition: service_healthy` can still race a moment of actual readiness under
 * load. Failure here is logged, not fatal — xcoder itself must still come up either way, and an
 * admin can always connect manually afterward from Platform > Tools.
 *
 * If XCODER_CODEGRAPH_API_KEY is set instead (a fixed, pre-known key rather than a password to
 * log in with), nothing to do here — codegraphKeyStore's own envDefault() already picks that up
 * directly with no login step needed.
 */
export function autoConnectFromEnv(): void {
  const env = envConnectConfig();
  if (!env || state !== null || autoConnect.inFlight) return;

  autoConnect = { inFlight: true, lastAttemptAt: Date.now(), error: undefined };
  connectExternalCodegraph(env.baseUrl, env.adminPassword, 120_000)
    .then(() => {
      autoConnect = { inFlight: false, lastAttemptAt: Date.now() };
      console.log(`[codegraph] auto-connected to ${env.baseUrl}`);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      autoConnect = { inFlight: false, lastAttemptAt: Date.now(), error: message };
      console.warn(`[codegraph] auto-connect to ${env.baseUrl} failed (non-fatal, will retry when the Explorer page next checks status): ${message}`);
    });
}

/** Called from the status route. If a sibling-service connection is expected but hasn't been
 *  established (the background attempt at startup timed out, or codegraph-api was restarted and
 *  xcoder lost its session), quietly try again — throttled so a polling UI can't hammer it. This
 *  is what makes "codegraph-api came up after xcoder gave up" self-heal instead of needing a
 *  manual reconnect or an api-container restart. */
export function retryAutoConnectIfNeeded(minIntervalMs = 15_000): void {
  if (state !== null || autoConnect.inFlight) return;
  if (Date.now() - autoConnect.lastAttemptAt < minIntervalMs) return;
  autoConnectFromEnv();
}

export function stopBundledCodegraph(): CodegraphStatus {
  if (state?.child) {
    state.child.kill();
  }
  // Only clear the connection if xcoder is the one managing it (spawned or auto-connected via
  // env) — if `state` is null but codegraphKeyStore still has a connection, an admin pointed it
  // at some other external instance manually via the form, which "stop" shouldn't touch.
  if (state) {
    state = null;
    clearCodegraphConnection();
  }
  return getStatus();
}

/** Generic "disconnect" for the manual-connect form's Disconnect button — unlike
 *  stopBundledCodegraph(), this always clears the connection (and tears down any managed
 *  process/state along with it), regardless of whether xcoder spawned it, auto-connected to it,
 *  or an admin pointed it at some instance by hand. Used by DELETE
 *  /platform/integrations/codegraph, which is a request to disconnect *something*, not
 *  specifically to stop a process xcoder itself started. */
export function disconnectCodegraph(): CodegraphStatus {
  if (state?.child) state.child.kill();
  state = null;
  clearCodegraphConnection();
  return getStatus();
}

/** Session info for the embedded CodeGraph Explorer iframe (see CodeGraphExplorerPage.tsx). The
 *  frontend writes these into localStorage before mounting the iframe so codegraph-ui, served
 *  same-origin at /codegraph-ui/, comes up already signed in. Admin-only — this is a real
 *  session token for CodeGraph's own admin account. Works for both spawned and externally
 *  connected instances, since both populate state.sso the same way. */
export function getSsoSession(): { apiUrl: string; token: string; user: unknown } | null {
  if (!state?.sso) return null;
  return { apiUrl: "/codegraph-api", token: state.sso.token, user: state.sso.user };
}

export type McpLaunch =
  | { mode: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { mode: "http"; url: string };

/**
 * Resolves the special "codegraph-mcp" command alias mcp_tool understands into whichever
 * transport can actually reach the CodeGraph MCP server:
 *
 * - XCODER_CODEGRAPH_MCP_URL set (docker-compose's `codegraph-mcp` service, reachable over the
 *   network) → streamable-http, no local process involved at all.
 * - otherwise → spawn integrations/codegraph/codegraph-mcp/server.py locally over stdio, same
 *   as before. Requires the bundled source to be present (see isBundleAvailable()) and a
 *   CodeGraph connection to already exist (spawned or externally connected) for its
 *   CODEGRAPH_API_URL/CODEGRAPH_API_KEY env.
 */
export function resolveBundledMcpLaunch(): McpLaunch {
  const networkUrl = process.env.XCODER_CODEGRAPH_MCP_URL;
  if (networkUrl) return { mode: "http", url: networkUrl };

  const conn = getCodegraphConnection();
  if (!conn) {
    throw new Error("CodeGraph is not connected — start it (or connect an external instance) under Platform > Integrations first.");
  }
  if (!fs.existsSync(CODEGRAPH_MCP_SERVER)) {
    throw new Error(
      `Bundled CodeGraph MCP server not found at ${CODEGRAPH_MCP_SERVER}, and XCODER_CODEGRAPH_MCP_URL isn't set. ` +
        `If you're running via docker-compose, set XCODER_CODEGRAPH_MCP_URL=http://codegraph-mcp:8900/mcp on the api service instead of relying on a local spawn.`
    );
  }
  return {
    mode: "stdio",
    command: resolvePythonExecutable(),
    args: [CODEGRAPH_MCP_SERVER],
    env: { CODEGRAPH_API_URL: conn.baseUrl, CODEGRAPH_API_KEY: conn.apiKey },
  };
}
