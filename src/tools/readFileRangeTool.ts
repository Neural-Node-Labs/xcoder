// ronin:version 2 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:47:28.262Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import { resolveWorkspacePath, hashContent, estimateTokens, CEILINGS, displayPath } from "./fsToolUtils.js";

export interface ReadFileRangeResult {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  readSha1: string;
  truncated: boolean;
  note?: string;
}

export function readFileRangeTool(
  args: { path: string; startLine: number; endLine: number },
  cwd: string = process.cwd()
): ReadFileRangeResult {
  const relPath = displayPath(args.path);
  const full = resolveWorkspacePath(args.path, cwd);
  let source: string;
  try {
    source = fs.readFileSync(full, "utf-8");
  } catch (err) {
    throw new Error(`Could not read "${args.path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const lines = source.split(/\r?\n/);
  const total = lines.length;
  const start = Math.max(1, args.startLine);
  const end = Math.min(total, args.endLine);
  if (start > total) {
    throw new Error(`startLine ${args.startLine} is beyond the file's ${total} lines.`);
  }
  let content = lines.slice(start - 1, end).join("\n");
  let truncated = false;
  let note: string | undefined;
  if (estimateTokens(content) > CEILINGS.readTokens) {
    // Truncate to a whole-line slice that fits the ceiling.
    let sliceEnd = end;
    let sliceLines = lines.slice(start - 1, sliceEnd);
    while (sliceLines.length > 0 && estimateTokens(sliceLines.join("\n")) > CEILINGS.readTokens) {
      sliceEnd--;
      sliceLines = lines.slice(start - 1, sliceEnd);
    }
    content = sliceLines.join("\n");
    truncated = true;
    note = "[Output truncated — request a narrower range]";
  }
  return {
    path: relPath,
    startLine: start,
    endLine: end,
    content,
    readSha1: hashContent(source),
    truncated,
    ...(note ? { note } : {}),
  };
}

export const handler = readFileRangeTool;
