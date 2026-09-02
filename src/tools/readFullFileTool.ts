// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:47:40.974Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import { resolveWorkspacePath, CEILINGS, countLines, displayPath } from "./fsToolUtils.js";

export interface ReadFullFileResult {
  path: string;
  lineCount: number;
  content: string;
}

export function readFullFileTool(
  args: { path: string; allowLarge?: boolean },
  cwd: string = process.cwd()
): ReadFullFileResult {
  const relPath = displayPath(args.path);
  const full = resolveWorkspacePath(args.path, cwd);
  let source: string;
  try {
    source = fs.readFileSync(full, "utf-8");
  } catch (err) {
    throw new Error(`Could not read "${args.path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const lineCount = countLines(source);
  if (lineCount > CEILINGS.fullFileLines && !args.allowLarge) {
    throw new Error(
      `read_full_file_tool refused: ${relPath} has ${lineCount} lines (gate is ${CEILINGS.fullFileLines} lines). ` +
        `Use read_outline_tool for the structure, then read_file_range_tool for the slice you need — or pass allowLarge: true to read the whole file.`
    );
  }
  return { path: relPath, lineCount, content: source };
}

export const handler = readFullFileTool;
