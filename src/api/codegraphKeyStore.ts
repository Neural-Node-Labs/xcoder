/**
 * Server-side store for the CodeGraph integration's connection details (Platform > Integrations
 * > CodeGraph). Mirrors llmKeyStore.ts's shape/persistence approach: a single platform-wide
 * connection, kept in memory and reloaded from an env var default on startup, settable at
 * runtime by an admin via PUT /platform/integrations/codegraph so no redeploy is needed to
 * connect or rotate the key.
 */

export interface CodegraphConnection {
  /** Base URL of the CodeGraph API server, e.g. "http://localhost:8000". No trailing slash. */
  baseUrl: string;
  /** Per-user CodeGraph API key, sent as the X-API-Key header on every request. */
  apiKey: string;
  /** Project id to query when a tool call doesn't specify one explicitly. */
  defaultProjectId?: string;
}

let connection: CodegraphConnection | null = envDefault();

function envDefault(): CodegraphConnection | null {
  const baseUrl = process.env.XCODER_CODEGRAPH_URL;
  const apiKey = process.env.XCODER_CODEGRAPH_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, defaultProjectId: process.env.XCODER_CODEGRAPH_PROJECT_ID };
}

export function getCodegraphConnection(): CodegraphConnection | null {
  return connection;
}

export function isCodegraphConnected(): boolean {
  return connection !== null;
}

export function setCodegraphConnection(conn: CodegraphConnection): void {
  connection = { ...conn, baseUrl: conn.baseUrl.replace(/\/+$/, "") };
}

/** Updates just the default project id on the current connection (e.g. after indexing a
 *  workspace into a newly-created CodeGraph project — see codegraphTool.ts's indexWorkspace()),
 *  without disturbing baseUrl/apiKey. No-op if there's no active connection. */
export function setDefaultProjectId(projectId: number): void {
  if (connection) connection.defaultProjectId = String(projectId);
}

export function clearCodegraphConnection(): void {
  connection = null;
}
