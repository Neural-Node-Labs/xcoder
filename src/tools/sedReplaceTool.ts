// ronin:version 2 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:49:05.075Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import { resolveWorkspacePath, displayPath } from "./fsToolUtils.js";

export interface SedReplaceResult {
  file: string;
  matches: number;
  replacementsApplied: number;
  validation: unknown;
}

export async function sedReplaceTool(
  args: { path: string; pattern: string; replacement: string; flags?: string; lineRange?: { start: number; end: number } },
  cwd: string = process.cwd()
): Promise<SedReplaceResult> {
  const relPath = displayPath(args.path);
  const full = resolveWorkspacePath(args.path, cwd);
  const source = fs.readFileSync(full, "utf-8");
  const lines = source.split(/\r?\n/);
  const flags = (args.flags ?? "g").replace(/y/g, "");
  const re = new RegExp(args.pattern, flags.replace(/g/g, ""));
  let replacementsApplied = 0;
  const start = Math.max(1, args.lineRange?.start ?? 1);
  const end = Math.min(lines.length, args.lineRange?.end ?? lines.length);
  for (let i = start - 1; i < end; i++) {
    const original = lines[i];
    const updated = original.replace(re, args.replacement);
    if (updated !== original) replacementsApplied++;
    lines[i] = updated;
  }
  fs.writeFileSync(full, lines.join("\n"), "utf-8");
  const matches = source.split(re).length - 1;
  return { file: relPath, matches, replacementsApplied, validation: { ok: true } };
}

export const handler = sedReplaceTool;
