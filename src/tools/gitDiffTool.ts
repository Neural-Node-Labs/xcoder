// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:47:47.531Z | ronin:subtask code-st-5a7e6a
import { execSync } from "node:child_process";
import { resolveWorkspacePath } from "./fsToolUtils.js";

interface GitStatEntry {
  file: string;
  additions: number;
  deletions: number;
}

export interface GitDiffResult {
  ref: string;
  stat: GitStatEntry[];
  rawDiff?: string;
  note?: string;
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export async function gitDiffTool(
  args: { ref?: string; path?: string; rawDiff?: boolean },
  cwd: string = process.cwd()
): Promise<GitDiffResult> {
  if (!isGitRepo(cwd)) {
    return { ref: args.ref ?? "HEAD", stat: [], note: "Not a git repository — no diff available. Use other read/edit tools instead." };
  }
  const ref = args.ref ?? "HEAD";
  const pathArg = args.path ? ` -- "${args.path.replace(/"/g, "\\\"")}"` : "";
  const statOut = execSync(`git diff --stat ${ref}${pathArg}`, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  const stat: GitStatEntry[] = [];
  for (const line of statOut.split(/\r?\n/)) {
    const m = /^\s*(.+?)\s*\|\s*(\d+)\s*[+-]+\s*$/.exec(line);
    if (m) {
      const file = m[1].trim();
      const additions = (line.match(/\+/g) ?? []).length;
      const deletions = (line.match(/-/g) ?? []).length;
      stat.push({ file, additions, deletions });
    }
  }
  const result: GitDiffResult = { ref, stat };
  if (args.rawDiff) {
    result.rawDiff = execSync(`git diff ${ref}${pathArg}`, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
  }
  return result;
}

export const handler = gitDiffTool;
