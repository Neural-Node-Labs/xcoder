/**
 * codegraph_tool — lets an xcoder engine query a connected CodeGraph instance: full-text search
 * over an indexed codebase's symbols, dependency/dependent traversal, blast-radius ("impact")
 * analysis, and shortest-path between two symbols. Backed by the CodeGraph REST API
 * (see codegraph-system/codegraph/app/api.py), authenticated with a per-deployment API key
 * configured under Platform > Integrations in the xcoder UI (see codegraphKeyStore.ts).
 */

import { getCodegraphConnection } from "../api/codegraphKeyStore.js";

export type CodegraphAction =
  | "search"
  | "get_node"
  | "dependencies"
  | "dependents"
  | "impact"
  | "path"
  | "unresolved"
  | "stats";

export interface CodegraphToolArgs {
  action: CodegraphAction;
  /** Overrides the integration's configured default project. */
  projectId?: number;
  /** search: the full-text query string. */
  query?: string;
  /** get_node / dependencies / dependents / impact: the node id to look up. */
  nodeId?: number;
  /** dependencies / dependents / impact: how many hops to traverse. */
  depth?: number;
  /** path: source node id (defaults to nodeId if provided). */
  source?: number;
  /** path: target node id. */
  target?: number;
  /** search / list endpoints: max rows to return. */
  limit?: number;
}

async function codegraphFetch(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
  const conn = getCodegraphConnection();
  if (!conn) {
    throw new Error(
      "CodeGraph is not connected. An admin needs to connect it under Platform > Integrations first."
    );
  }

  const url = new URL(conn.baseUrl + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const res = await fetch(url.toString(), { headers: { "X-API-Key": conn.apiKey } });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === "object" && body && "detail" in (body as any) ? (body as any).detail : text;
    throw new Error(`CodeGraph API error ${res.status}: ${detail}`);
  }
  return body;
}

function resolveProjectId(args: CodegraphToolArgs): number {
  const conn = getCodegraphConnection();
  const projectId = args.projectId ?? (conn?.defaultProjectId ? Number(conn.defaultProjectId) : undefined);
  if (projectId === undefined || Number.isNaN(projectId)) {
    throw new Error("codegraph_tool: projectId is required (no default configured for this integration).");
  }
  return projectId;
}

export async function runCodegraphTool(args: CodegraphToolArgs): Promise<string> {
  const projectId = resolveProjectId(args);

  switch (args.action) {
    case "search": {
      if (!args.query) throw new Error("codegraph_tool: 'query' is required for action 'search'.");
      const result = await codegraphFetch("/api/search", { project_id: projectId, q: args.query, limit: args.limit ?? 25 });
      return JSON.stringify(result, null, 2);
    }
    case "get_node": {
      if (args.nodeId === undefined) throw new Error("codegraph_tool: 'nodeId' is required for action 'get_node'.");
      const result = await codegraphFetch(`/api/nodes/${args.nodeId}`, { project_id: projectId });
      return JSON.stringify(result, null, 2);
    }
    case "dependencies": {
      if (args.nodeId === undefined) throw new Error("codegraph_tool: 'nodeId' is required for action 'dependencies'.");
      const result = await codegraphFetch(`/api/nodes/${args.nodeId}/dependencies`, {
        project_id: projectId,
        depth: args.depth ?? 1,
      });
      return JSON.stringify(result, null, 2);
    }
    case "dependents": {
      if (args.nodeId === undefined) throw new Error("codegraph_tool: 'nodeId' is required for action 'dependents'.");
      const result = await codegraphFetch(`/api/nodes/${args.nodeId}/dependents`, {
        project_id: projectId,
        depth: args.depth ?? 1,
      });
      return JSON.stringify(result, null, 2);
    }
    case "impact": {
      if (args.nodeId === undefined) throw new Error("codegraph_tool: 'nodeId' is required for action 'impact'.");
      const result = await codegraphFetch(`/api/nodes/${args.nodeId}/impact`, {
        project_id: projectId,
        depth: args.depth ?? 2,
      });
      return JSON.stringify(result, null, 2);
    }
    case "path": {
      const source = args.source ?? args.nodeId;
      if (source === undefined || args.target === undefined) {
        throw new Error("codegraph_tool: 'source' (or 'nodeId') and 'target' are required for action 'path'.");
      }
      const result = await codegraphFetch("/api/path", { project_id: projectId, source, target: args.target });
      return JSON.stringify(result, null, 2);
    }
    case "unresolved": {
      const result = await codegraphFetch("/api/unresolved", { project_id: projectId, limit: args.limit ?? 100 });
      return JSON.stringify(result, null, 2);
    }
    case "stats": {
      const result = await codegraphFetch("/api/stats", { project_id: projectId });
      return JSON.stringify(result, null, 2);
    }
    default:
      throw new Error(`codegraph_tool: unknown action '${(args as { action: string }).action}'.`);
  }
}
