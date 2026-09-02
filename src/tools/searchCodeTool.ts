// ronin:version 3 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:46:37.572Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { loadIgnoreRules } from "../indexing/ignoreRules.js";
import { CEILINGS, truncateActionable } from "./fsToolUtils.js";

interface SearchMatch {
  file: string;
  line: number;
  text: string;
  context?: string[];
}

export interface SearchCodeResult {
  matches: SearchMatch[];
  matchCount: number;
  truncated: boolean;
  note?: string;
}

export async function searchCodeTool(
  args: { pattern: string; globPattern?: string; contextLines?: number },
  cwd: string = process.cwd()
): Promise<SearchCodeResult> {
  const contextLines = Math.min(Math.max(0, args.contextLines ?? 2), CEILINGS.maxContextLines);
  const ignore = loadIgnoreRules(cwd);
  const files = await fg(args.globPattern ?? "**/*", { cwd, ignore, dot: false, onlyFiles: true });
  const re = new RegExp(args.pattern);
  const matches: SearchMatch[] = [];

  for (const file of files) {
    if (matches.length >= CEILINGS.searchMatches) break;
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(cwd, file), "utf-8").split(/\r?\n/);
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length && matches.length < CEILINGS.searchMatches; i++) {
      const line = i + 1;
      if (re.test(lines[i])) {
        const context = contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), Math.min(lines.length, i + contextLines + 1)) : undefined;
        matches.push({ file, line, text: lines[i], ...(context ? { context } : {}) });
      }
      re.lastIndex = 0;
    }
  }

  const res = truncateActionable(matches, CEILINGS.searchMatches, "matches", "Add globPattern to narrow, or tighten the regex.");
  return {
    matches: res.items as SearchMatch[],
    matchCount: matches.length,
    truncated: res.truncated,
    ...(res.note ? { note: res.note } : {}),
  };
}

export const handler = searchCodeTool;
