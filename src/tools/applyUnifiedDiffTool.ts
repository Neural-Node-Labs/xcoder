// ronin:version 3 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:52:43.510Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import { execSync } from "node:child_process";
import { resolveWorkspacePath, displayPath } from "./fsToolUtils.js";

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  lines: { prefix: " " | "+" | "-"; text: string }[];
}

export interface ApplyUnifiedDiffResult {
  file: string;
  status: "applied";
  validation: unknown;
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function parseDiff(diff: string): { path?: string; hunks: Hunk[] } {
  const lines = diff.split(/\r?\n/);
  const hunks: Hunk[] = [];
  let path: string | undefined;
  let current: Hunk | null = null;
  let failLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = /^\+\+\+ (?:[ab]\/)?(.+)$/.exec(line);
    if (header) {
      const p = header[1].trim();
      if (p !== "/dev/null") path = p;
      continue;
    }
    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkHeader) {
      current = {
        oldStart: Number(hunkHeader[1]),
        oldCount: hunkHeader[2] ? Number(hunkHeader[2]) : 1,
        newStart: Number(hunkHeader[3]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current) {
      const prefix = line[0];
      if (prefix === " " || prefix === "+" || prefix === "-") {
        current.lines.push({ prefix, text: line.slice(1) });
      } else if (line.startsWith("\\")) {
        // no-newline marker — ignore
      } else if (line.trim() === "") {
        // blank line inside context: treat as context
        current.lines.push({ prefix: " ", text: "" });
      } else {
        failLine = i + 1;
        break;
      }
    }
  }
  if (failLine > 0) {
    throw new Error(`apply_unified_diff_tool: invalid diff at line ${failLine}: "${lines[failLine - 1]}". The file was not modified.`);
  }
  return { path, hunks };
}

function applyHunks(content: string, hunks: Hunk[]): string {
  const lines = content.split(/\r?\n/);
  let offset = 0;
  for (const h of hunks) {
    const relStart = h.oldStart - 1 + offset;
    if (relStart < 0 || relStart > lines.length) {
      throw new Error(`apply_unified_diff_tool: hunk at old line ${h.oldStart} is out of range. The file was not modified.`);
    }
    let idx = relStart;
    let ok = true;
    let consumed = relStart;
    for (const l of h.lines) {
      if (l.prefix === " " || l.prefix === "-") {
        if (lines[idx] !== l.text) {
          ok = false;
          break;
        }
        idx++;
        consumed = idx;
      }
    }
    if (!ok) {
      throw new Error(`apply_unified_diff_tool: hunk at old line ${h.oldStart} does not match file content. The file was not modified.`);
    }
    const newLines: string[] = [];
    for (const l of h.lines) {
      if (l.prefix === " ") { newLines.push(l.text); }
      else if (l.prefix === "+") { newLines.push(l.text); }
    }
    const removed = h.lines.filter((l) => l.prefix === "-").length;
    const added = h.lines.filter((l) => l.prefix === "+").length;
    const tail = lines.slice(consumed);
    const head = lines.slice(0, relStart);
    lines.length = 0;
    lines.push(...head, ...newLines, ...tail);
    offset += added - removed;
  }
  return lines.join("\n");
}

export async function applyUnifiedDiffTool(
  args: { path: string; diff: string },
  cwd: string = process.cwd()
): Promise<ApplyUnifiedDiffResult> {
  const relPath = displayPath(args.path);
  const parsed = parseDiff(args.diff);
  const targetRel = parsed.path ?? relPath;
  const full = resolveWorkspacePath(targetRel, cwd);
  const source = fs.readFileSync(full, "utf-8");
  const updated = applyHunks(source, parsed.hunks);
  if (isGitRepo(cwd)) {
    try {
      execSync("git apply --check -", { cwd, input: args.diff, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      const e = err as Error & { stderr?: string | Buffer };
      const msg = e.stderr?.toString() ?? e.message;
      throw new Error(`apply_unified_diff_tool: git apply --check failed — zero writes. First failing hunk: ${msg.split(/\r?\n/)[0]}`);
    }
  }
  fs.writeFileSync(full, updated, "utf-8");
  return { file: targetRel, status: "applied", validation: { ok: true } };
}

export const handler = applyUnifiedDiffTool;
