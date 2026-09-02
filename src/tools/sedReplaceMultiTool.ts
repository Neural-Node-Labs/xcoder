// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:49:11.005Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { loadIgnoreRules } from "../indexing/ignoreRules.js";
import { displayPath } from "./fsToolUtils.js";

interface AffectedFile {
  file: string;
  matches: number;
  sampleDiff?: string;
}

export interface SedReplaceMultiResult {
  dryRun: boolean;
  affectedFiles: AffectedFile[];
  diffSummary?: string;
}

export async function sedReplaceMultiTool(
  args: { globPattern: string; pattern: string; replacement: string; flags?: string; dryRun?: boolean },
  cwd: string = process.cwd()
): Promise<SedReplaceMultiResult> {
  const dryRun = args.dryRun ?? true;
  const flags = (args.flags ?? "g").replace(/y/g, "");
  const re = new RegExp(args.pattern, flags.replace(/g/g, ""));
  const ignore = loadIgnoreRules(cwd);
  const files = await fg(args.globPattern, { cwd, ignore, dot: false, onlyFiles: true });
  const affectedFiles: AffectedFile[] = [];
  let totalMatches = 0;

  for (const file of files) {
    const full = path.join(cwd, file);
    const original = fs.readFileSync(full, "utf-8");
    const matches = (original.match(new RegExp(args.pattern, flags.replace(/g/g, ""))) ?? []).length;
    if (matches > 0) {
      const updated = original.replace(re, args.replacement);
      totalMatches += matches;
      const entry: AffectedFile = { file: displayPath(file), matches };
      if (dryRun) {
        const lines = original.split(/\r?\n/);
        const firstIdx = lines.findIndex((l) => re.test(l));
        if (firstIdx >= 0) {
          const from = Math.max(0, firstIdx - 1);
          const to = Math.min(lines.length, firstIdx + 2);
          entry.sampleDiff = `  ${lines.slice(from, to).map((l) => `- ${l}`).join("\n")}\n  ${updated.split(/\r?\n/).slice(from, to).map((l) => `+ ${l}`).join("\n")}`;
        }
      } else {
        fs.writeFileSync(full, updated, "utf-8");
      }
      affectedFiles.push(entry);
    }
  }

  return {
    dryRun,
    affectedFiles,
    ...(totalMatches > 0 ? { diffSummary: `${totalMatches} match(es) across ${affectedFiles.length} file(s)` } : {}),
  };
}

export const handler = sedReplaceMultiTool;
