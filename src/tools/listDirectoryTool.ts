// ronin:version 2 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:46:20.274Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspacePath, CEILINGS, truncateActionable } from "./fsToolUtils.js";

interface DirEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

export interface ListDirectoryResult {
  directory: string;
  entries: DirEntry[];
  truncated: boolean;
  note?: string;
}

function isIgnored(rel: string, ignorePatterns: string[]): boolean {
  const normalized = rel.replace(/\\/g, "/");
  for (const pattern of ignorePatterns) {
    const p = pattern.replace(/\\/g, "/");
    if (p.startsWith("**/")) {
      const suffix = p.slice(3);
      if (normalized === suffix || normalized.endsWith("/" + suffix) || normalized.startsWith(suffix + "/")) return true;
    } else if (normalized === p || normalized.startsWith(p + "/")) {
      return true;
    }
  }
  return false;
}

function walk(dir: string, cwd: string, depth: number, maxDepth: number, entries: DirEntry[], ignore: string[], prefix: string): boolean {
  if (entries.length >= CEILINGS.listEntries) return false;
  let full: string;
  try {
    full = resolveWorkspacePath(prefix || ".", cwd);
  } catch {
    return true;
  }
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(full, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const item of items) {
    if (entries.length >= CEILINGS.listEntries) return false;
    const rel = prefix ? path.posix.join(prefix.replace(/\\/g, "/"), item.name) : item.name;
    if (isIgnored(rel, ignore)) continue;
    const type = item.isDirectory() ? "dir" : "file";
    const entry: DirEntry = { name: rel, type };
    if (type === "file") {
      try {
        const abs = path.join(full, item.name);
        entry.size = fs.statSync(abs).size;
      } catch {
        // best-effort size
      }
    }
    entries.push(entry);
    if (type === "dir" && depth < maxDepth) {
      if (!walk(dir, cwd, depth + 1, maxDepth, entries, ignore, rel)) return false;
    }
  }
  return true;
}

export async function listDirectoryTool(
  args: { path?: string; depth?: number },
  cwd: string = process.cwd()
): Promise<ListDirectoryResult> {
  const relDir = args.path && args.path.trim() !== "" ? args.path.trim().replace(/\\/g, "/").replace(/^\.\//, "") : ".";
  const depth = Math.min(Math.max(1, args.depth ?? 2), CEILINGS.maxDepth);
  const full = resolveWorkspacePath(relDir, cwd);

  // Best-effort ignore rules using the shared ignore loader.
  let ignore: string[] = [];
  try {
    const { loadIgnoreRules } = await import("../indexing/ignoreRules.js");
    ignore = loadIgnoreRules(cwd);
  } catch {
    ignore = [];
  }

  const entries: DirEntry[] = [];
  walk(full, cwd, 1, depth, entries, ignore, relDir === "." ? "" : relDir);

  const res = truncateActionable(entries, CEILINGS.listEntries, "entries", "Add a path argument to list a subdirectory.");
  return {
    directory: relDir === "." ? "." : relDir,
    entries: res.items as DirEntry[],
    truncated: res.truncated,
    ...(res.note ? { note: res.note } : {}),
  };
}

export const handler = listDirectoryTool;
