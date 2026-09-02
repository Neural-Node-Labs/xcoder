// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:48:55.739Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import { resolveWorkspacePath, displayPath } from "./fsToolUtils.js";

export interface SearchReplaceBlockResult {
  file: string;
  status: "applied";
  validation: unknown;
}

export async function searchReplaceBlockTool(
  args: { path: string; searchBlock: string; replaceBlock: string },
  cwd: string = process.cwd()
): Promise<SearchReplaceBlockResult> {
  const relPath = displayPath(args.path);
  const full = resolveWorkspacePath(args.path, cwd);
  const source = fs.readFileSync(full, "utf-8");
  const occurrences = source.split(args.searchBlock).length - 1;
  if (occurrences === 0) {
    throw new Error(`search_replace_block_tool: searchBlock not found in ${relPath}. The file was not modified.`);
  }
  if (occurrences > 1) {
    throw new Error(`search_replace_block_tool: searchBlock is not unique in ${relPath} (${occurrences} matches). Include more surrounding context. The file was not modified.`);
  }
  const updated = source.replace(args.searchBlock, args.replaceBlock);
  fs.writeFileSync(full, updated, "utf-8");
  return { file: relPath, status: "applied", validation: { ok: true } };
}

export const handler = searchReplaceBlockTool;
