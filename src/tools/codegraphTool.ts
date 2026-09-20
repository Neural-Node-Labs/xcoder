/**
 * codegraph_tool — lets an xcoder engine query a connected CodeGraph instance: full-text search
 * over an indexed codebase's symbols, dependency/dependent traversal, blast-radius ("impact")
 * analysis, shortest-path between two symbols, and indexing an xcoder project's own workspace
 * into CodeGraph in the first place. Backed by the CodeGraph REST API
 * (see integrations/codegraph/codegraph/app/api.py), authenticated with a per-deployment API
 * key configured under Platform > Integrations in the xcoder UI (see codegraphKeyStore.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { createRequire } from "node:module";
import { getCodegraphConnection, setDefaultProjectId } from "../api/codegraphKeyStore.js";
import { EXCLUDED } from "../core/workspaceManager.js";
import { resolveConfinedPath } from "./workspaceConfinement.js";

const require = createRequire(import.meta.url);
const archiver = require("archiver");

export type CodegraphAction =
  | "search"
  | "get_node"
  | "dependencies"
  | "dependents"
  | "impact"
  | "path"
  | "unresolved"
  | "stats"
  | "index_workspace";

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
  /** index_workspace: subpath within the current project to index, relative to cwd. Defaults to
   *  the whole workspace. */
  path?: string;
  /** index_workspace: name for the CodeGraph project. Defaults to the workspace directory's
   *  name. Reuses an existing CodeGraph project with this exact name if one exists, rather than
   *  creating a duplicate — so re-indexing after a code change is idempotent. */
  projectName?: string;
}

async function codegraphFetch(urlPath: string, params: Record<string, string | number | undefined>): Promise<unknown> {
  const conn = getCodegraphConnection();
  if (!conn) {
    throw new Error(
      "CodeGraph is not connected. An admin needs to connect it under Platform > Integrations first."
    );
  }

  const url = new URL(conn.baseUrl + urlPath);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const res = await fetch(url.toString(), { headers: { "X-API-Key": conn.apiKey } });
  return parseCodegraphResponse(res);
}

async function parseCodegraphResponse(res: Response): Promise<unknown> {
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

// ---------------------------------------------------------------------
// index_workspace
// ---------------------------------------------------------------------

/** Zips a directory to a temp file using the same exclusion set (node_modules, .git, dist,
 *  build, the isolated-workspace dir, etc.) xcoder's own project-download route uses, so what
 *  gets indexed matches what a person downloading the project would see. */
function zipWorkspace(root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), `xcoder-codegraph-${crypto.randomBytes(8).toString("hex")}.zip`);
    const output = fs.createWriteStream(tmpPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve(tmpPath));
    archive.on("error", (err: Error) => reject(err));
    archive.pipe(output);
    archive.glob("**/*", {
      cwd: root,
      ignore: [...EXCLUDED].map((e) => `**/${e}/**`),
      dot: false,
    });
    archive.finalize();
  });
}

interface CodegraphProject {
  id: number;
  name: string;
  status: string;
}

async function findOrCreateProject(name: string): Promise<CodegraphProject> {
  const conn = getCodegraphConnection();
  if (!conn) throw new Error("CodeGraph is not connected. An admin needs to connect it under Platform > Integrations first.");

  const existing = (await codegraphFetch("/api/projects", {})) as { results: CodegraphProject[] };
  const match = existing.results?.find((p) => p.name === name);
  if (match) return match;

  const res = await fetch(`${conn.baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": conn.apiKey },
    body: JSON.stringify({ name, description: "Indexed from xcoder" }),
  });
  return (await parseCodegraphResponse(res)) as CodegraphProject;
}

async function uploadZip(projectId: number, zipPath: string): Promise<{ extracted_files: number }> {
  const conn = getCodegraphConnection();
  if (!conn) throw new Error("CodeGraph is not connected.");

  const buf = fs.readFileSync(zipPath);
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "application/zip" }), "workspace.zip");

  const res = await fetch(`${conn.baseUrl}/api/projects/${projectId}/upload`, {
    method: "POST",
    headers: { "X-API-Key": conn.apiKey }, // no Content-Type — fetch sets the multipart boundary
    body: form,
  });
  return (await parseCodegraphResponse(res)) as { extracted_files: number };
}

async function triggerIndex(projectId: number): Promise<unknown> {
  const conn = getCodegraphConnection();
  if (!conn) throw new Error("CodeGraph is not connected.");
  const res = await fetch(`${conn.baseUrl}/api/projects/${projectId}/index`, {
    method: "POST",
    headers: { "X-API-Key": conn.apiKey },
  });
  return parseCodegraphResponse(res);
}

async function indexWorkspace(cwd: string, args: CodegraphToolArgs): Promise<string> {
  // Routed through the same opt-in confinement every other file-touching tool honors (see
  // workspaceConfinement.ts) — a no-op unless an admin has set XCODER_RESTRICT_TO_WORKSPACE=true,
  // but when they have, this tool needs to respect it too rather than being a silent exception
  // that can still zip and upload paths outside the intended workspace.
  const workspacePath = args.path ? resolveConfinedPath(args.path, cwd) : cwd;
  if (!fs.existsSync(workspacePath)) {
    throw new Error(`codegraph_tool: workspace path does not exist: ${workspacePath}`);
  }
  const projectName = args.projectName?.trim() || path.basename(workspacePath);

  const project = await findOrCreateProject(projectName);
  const zipPath = await zipWorkspace(workspacePath);
  try {
    const upload = await uploadZip(project.id, zipPath);
    const indexResult = await triggerIndex(project.id);
    setDefaultProjectId(project.id);
    return JSON.stringify(
      {
        codegraphProjectId: project.id,
        codegraphProjectName: projectName,
        extractedFiles: upload.extracted_files,
        indexResult,
        note: `Set as the default CodeGraph project for this integration — subsequent codegraph_tool calls default to project_id ${project.id} unless overridden.`,
      },
      null,
      2
    );
  } finally {
    fs.unlink(zipPath, () => {});
  }
}

// ---------------------------------------------------------------------

export async function runCodegraphTool(args: CodegraphToolArgs, cwd: string = process.cwd()): Promise<string> {
  if (args.action === "index_workspace") {
    return indexWorkspace(cwd, args);
  }

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
