import {
  readCachedWorkspaceInfo,
  refreshWorkspaceInfo,
  summarizeWorkspaceInfo,
  WorkspaceInfo,
} from "../indexing/workspaceInfo.js";

export interface WorkspaceInfoResult {
  summary: string;
  info: WorkspaceInfo;
  refreshed: boolean;
}

/**
 * Returns the workspace snapshot as an LLM-facing summary plus the full structured data.
 * `refresh=true` forces a rebuild (this is the "LLM can re-trigger the refresh" path — use it
 * after installing dependencies, creating/deleting files, or switching branches mid-task).
 * `refresh=false` (or omitted) uses the cached snapshot if one exists, building fresh only if
 * no cache is present yet. Any fresh build always writes the cache, so both paths converge.
 */
export async function getWorkspaceInfo(cwd: string, refresh: boolean): Promise<WorkspaceInfoResult> {
  const cached = !refresh ? readCachedWorkspaceInfo(cwd) : undefined;
  const info = cached ?? (await refreshWorkspaceInfo(cwd));
  return { summary: summarizeWorkspaceInfo(info), info, refreshed: !cached };
}
