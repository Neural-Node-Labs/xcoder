// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:48:08.314Z | ronin:subtask code-st-5a7e6a
import { execSync } from "node:child_process";

interface GitLogEntry {
  hash: string;
  subject: string;
  author?: string;
  date?: string;
}

export interface GitLogResult {
  path?: string;
  maxCount: number;
  entries: GitLogEntry[];
  note?: string;
}

export async function gitLogTool(
  args: { path?: string; maxCount?: number },
  cwd: string = process.cwd()
): Promise<GitLogResult> {
  const maxCount = Math.max(1, Math.min(args.maxCount ?? 10, 50));
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
  } catch {
    return { maxCount, entries: [], note: "Not a git repository — no log available." };
  }
  const pathArg = args.path ? ` -- "${args.path.replace(/"/g, "\\\"")}"` : "";
  const out = execSync(`git log -n ${maxCount} --pretty=format:%H%x09%an%x09%ad%x09%s --date=short${pathArg}`, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const entries: GitLogEntry[] = out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, ...subjectParts] = line.split("\t");
      return { hash, subject: subjectParts.join("\t"), ...(author ? { author } : {}), ...(date ? { date } : {}) };
    });
  return { ...(args.path ? { path: args.path } : {}), maxCount, entries };
}

export const handler = gitLogTool;
