// ronin:version 2 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:46:24.661Z | ronin:subtask code-st-5a7e6a
import fg from "fast-glob";
import { loadIgnoreRules } from "../indexing/ignoreRules.js";
import { CEILINGS, truncateActionable } from "./fsToolUtils.js";

export interface FindFilesResult {
  files: string[];
  truncated: boolean;
  note?: string;
}

export async function findFilesTool(
  args: { pattern: string; limit?: number },
  cwd: string = process.cwd()
): Promise<FindFilesResult> {
  const limit = Math.max(1, Math.min(args.limit ?? 200, CEILINGS.searchMatches));
  const ignore = loadIgnoreRules(cwd);
  const matches = await fg(args.pattern, { cwd, ignore, dot: false, onlyFiles: true });
  const res = truncateActionable(matches, limit, "files", "Add a more specific glob pattern to narrow the search.");
  return {
    files: res.items as string[],
    truncated: res.truncated,
    ...(res.note ? { note: res.note } : {}),
  };
}

export const handler = findFilesTool;
