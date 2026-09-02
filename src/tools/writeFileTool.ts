// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:50:09.971Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspacePath, CEILINGS, countLines, displayPath } from "./fsToolUtils.js";

export interface WriteFileToolResult {
  file: string;
  bytesWritten: number;
  lineCount: number;
  ceilingExceeded: boolean;
  validation: unknown;
}

export async function writeFileTool(
  args: { path: string; content: string; force?: boolean },
  cwd: string = process.cwd()
): Promise<WriteFileToolResult> {
  const relPath = displayPath(args.path);
  const full = resolveWorkspacePath(args.path, cwd);
  const lineCount = countLines(args.content ?? "");
  if (lineCount > CEILINGS.writeFileLines && !args.force) {
    throw new Error(
      `write_file_tool refused: ${relPath} has ${lineCount} lines (soft ceiling ${CEILINGS.writeFileLines}). ` +
        `For partial changes use search_replace_block_tool / line_patch_tool / apply_unified_diff_tool. ` +
        `To write the full file anyway pass force: true. The file was not written.`
    );
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, args.content ?? "", "utf-8");
  return {
    file: relPath,
    bytesWritten: Buffer.byteLength(args.content ?? "", "utf-8"),
    lineCount,
    ceilingExceeded: lineCount > CEILINGS.writeFileLines,
    validation: { ok: true },
  };
}

export const handler = writeFileTool;
