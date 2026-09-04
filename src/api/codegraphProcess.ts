/**
 * Manages the CodeGraph API server that ships bundled inside xcoder (integrations/codegraph/).
 * "Bundled" means xcoder owns its full lifecycle — spawn, health-check, auto-authenticate, and
 * tear down — so connecting CodeGraph from Platform > Integrations can be a single click rather
 * than standing up a separate deployment and pasting in a URL + API key by hand. (That manual
 * path — codegraphKeyStore.setCodegraphConnection() pointed at an externally-hosted instance —
 * still works too, for teams who'd rather run CodeGraph themselves.)
 *
 * Every CodeGraph instance seeds its own local admin user on first boot (see
 * codegraph/app/db.py's seed_admin_if_missing) with a random password we generate and persist
 * once. On every start() we log in as that admin over HTTP to obtain a session token and the
 * admin's API key, then feed the API key into codegraphKeyStore so codegraph_tool starts working
 * immediately, and keep the session token in memory for the embedded-UI SSO bridge (see
 * getSsoSession() and CodeGraphExplorerPage.tsx on the frontend).
 */

import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { setCodegraphConnection, clearCodegraphConnection, getCodegraphConnection } from "./codegraphKeyStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** integrations/codegraph, relative to this file's location (src/api → dist/api at build time). */
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

interface RunningState {
  child: ChildProcess;
  port: number;
  startedAt: string;
  /** Admin session token + user, refreshed on every start(); used only for the embedded-UI SSO
   *  bridge — API calls from tools go through the API key in codegraphKeyStore instead. */
  sso: { token: string; user: { id: number; username: string; role: string; api_key: string } } | null;
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

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`CodeGraph server didn't become healthy within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function loginAsAdmin(port: number, password: string): Promise<RunningState["sso"]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  if (!res.ok) {
    throw new Error(`CodeGraph admin login failed (${res.status}). If credentials were regenerated after CodeGraph's data dir was already initialized, delete ${DATA_DIR} to reset both together.`);
  }
  return (await res.json()) as RunningState["sso"];
}

export interface CodegraphStatus {
  bundled: boolean; // whether the bundled source is present in this build at all
  running: boolean;
  port?: number;
  baseUrl?: string;
  startedAt?: string;
  uiAvailable: boolean; // whether codegraph-ui/dist has been built
}

export function isBundleAvailable(): boolean {
  return fs.existsSync(path.join(CODEGRAPH_API_DIR, "app", "api.py"));
}

export function getStatus(): CodegraphStatus {
  return {
    bundled: isBundleAvailable(),
    running: state !== null,
    port: state?.port,
    baseUrl: state ? `http://127.0.0.1:${state.port}` : undefined,
    startedAt: state?.startedAt,
    uiAvailable: fs.existsSync(path.join(CODEGRAPH_UI_DIST, "index.html")),
  };
}

/** Start the bundled CodeGraph API server if it isn't already running, and point
 *  codegraphKeyStore at it. Idempotent — calling this while already running just returns the
 *  existing status. */
export async function startBundledCodegraph(): Promise<CodegraphStatus> {
  if (state) return getStatus();
  if (!isBundleAvailable()) {
    throw new Error(`CodeGraph source not found under ${CODEGRAPH_API_DIR}. This build wasn't packaged with integrations/codegraph/.`);
  }

  const creds = loadOrCreateAdminCredentials();
  const port = DEFAULT_PORT;
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
    await waitForHealth(port, 20_000);
    const sso = await loginAsAdmin(port, creds.password);
    if (!sso) throw new Error("CodeGraph admin login returned no session");

    state = { child, port, startedAt: new Date().toISOString(), sso };
    setCodegraphConnection({ baseUrl: `http://127.0.0.1:${port}`, apiKey: sso.user.api_key });
    return getStatus();
  } catch (err) {
    child.kill();
    state = null;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to start bundled CodeGraph: ${message}${startupLog ? `\n--- server output ---\n${startupLog.slice(-1500)}` : ""}`);
  }
}

export function stopBundledCodegraph(): CodegraphStatus {
  if (state) {
    state.child.kill();
    state = null;
  }
  // Only clear the connection if it's still pointed at a bundled (127.0.0.1) instance — an
  // admin may have since pointed it at an external CodeGraph deployment instead, which
  // stopping the bundled process shouldn't disturb.
  const conn = getCodegraphConnection();
  if (conn && /^https?:\/\/(127\.0\.0\.1|localhost)/.test(conn.baseUrl)) {
    clearCodegraphConnection();
  }
  return getStatus();
}

/** Session info for the embedded CodeGraph Explorer iframe (see CodeGraphExplorerPage.tsx). The
 *  frontend writes these into localStorage before mounting the iframe so codegraph-ui, served
 *  same-origin at /codegraph-ui/, comes up already signed in. Admin-only — this is a real
 *  session token for CodeGraph's own admin account. */
export function getSsoSession(): { apiUrl: string; token: string; user: unknown } | null {
  if (!state?.sso) return null;
  return { apiUrl: "/codegraph-api", token: state.sso.token, user: state.sso.user };
}

/** Resolves the special "codegraph-mcp" command alias mcp_tool understands into the actual
 *  interpreter + bundled server script + connection env, so calling the bundled CodeGraph MCP
 *  server needs no manual path/command configuration — see mcpTool.ts. */
export function resolveBundledMcpLaunch(): { command: string; args: string[]; env: Record<string, string> } {
  const conn = getCodegraphConnection();
  if (!conn) {
    throw new Error("CodeGraph is not connected — start it (or connect an external instance) under Platform > Integrations first.");
  }
  if (!fs.existsSync(CODEGRAPH_MCP_SERVER)) {
    throw new Error(`Bundled CodeGraph MCP server not found at ${CODEGRAPH_MCP_SERVER}.`);
  }
  return {
    command: resolvePythonExecutable(),
    args: [CODEGRAPH_MCP_SERVER],
    env: { CODEGRAPH_API_URL: conn.baseUrl, CODEGRAPH_API_KEY: conn.apiKey },
  };
}
