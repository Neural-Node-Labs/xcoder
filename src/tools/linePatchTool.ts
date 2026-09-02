// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:49:17.144Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import crypto from "node:crypto";
import { resolveWorkspacePath, displayPath } from "./fsToolUtils.js";

export interface LinePatchResult {
  file: string;
  status: "applied";
  validation: unknown;
}

function sha1(s: string): string {
  return crypto.createHash("sha1").update(s, "utf-8").digest("hex");
}

export async function linePatchTool(
  args: { path: string; startLine: number; endLine: number; newContent: string; expectedSha1: string },
  cwd: string = process.cwd()
): Promise<LinePatchResult> {
  const relPath = displayPath(args.path);
  const full = resolveWorkspacePath(args.path, cwd);
  const source = fs.readFileSync(full, "utf-8");
  const currentHash = sha1(source);
  if (currentHash !== args.expectedSha1) {
    throw new Error(
      `line_patch_tool refused: the file ${relPath} changed since you read it (current sha1 ${currentHash}, expected ${args.expectedSha1}). ` +
        `Re-read the range with read_file_range_tool / read_multiple_files_tool, then retry with the new expectedSha1. The file was not modified.`
    );
  }
  const lines = source.split(/\r?\n/);
  const start = Math.max(1, args.startLine);
  const end = Math.min(lines.length, args.endLine);
  if (start > lines.length) {
    throw new Error(`line_patch_tool: startLine ${args.startLine} beyond file's ${lines.length} lines. The file was not modified.`);
  }
  const newLines = args.newContent.split(/\r?\n/);
  const updated = [...lines.slice(0, start - 1), ...newLines, ...lines.slice(end)];
  fs.writeFileSync(full, updated.join("\n"), "utf-8");
  return { file: relPath, status: "applied", validation: { ok: true } };
}

export const handler = linePatchTool;
