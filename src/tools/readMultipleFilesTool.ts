// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:47:34.814Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import { resolveWorkspacePath, hashContent, estimateTokens, CEILINGS, displayPath } from "./fsToolUtils.js";

interface SectionRequest {
  path: string;
  startLine?: number;
  endLine?: number;
}

interface Section {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  readSha1: string;
}

export interface ReadMultipleFilesResult {
  sections: Section[];
  truncatedSections: string[];
  note?: string;
}

export async function readMultipleFilesTool(
  args: { files: SectionRequest[] },
  cwd: string = process.cwd()
): Promise<ReadMultipleFilesResult> {
  const sections: Section[] = [];
  const truncatedSections: string[] = [];
  const notes: string[] = [];
  let totalTokens = 0;

  for (const req of args.files ?? []) {
    const relPath = displayPath(req.path);
    const full = resolveWorkspacePath(req.path, cwd);
    let source: string;
    try {
      source = fs.readFileSync(full, "utf-8");
    } catch (err) {
      notes.push(`Could not read "${req.path}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const lines = source.split(/\r?\n/);
    const start = Math.max(1, req.startLine ?? 1);
    const end = Math.min(lines.length, req.endLine ?? lines.length);
    if (start > lines.length) {
      notes.push(`"${req.path}": startLine ${start} beyond file's ${lines.length} lines`);
      continue;
    }
    let content = lines.slice(start - 1, end).join("\n");
    let truncated = false;
    if (estimateTokens(content) > CEILINGS.readTokens) {
      let sliceEnd = end;
      let sliceLines = lines.slice(start - 1, sliceEnd);
      while (sliceLines.length > 0 && estimateTokens(sliceLines.join("\n")) > CEILINGS.readTokens) {
        sliceEnd--;
        sliceLines = lines.slice(start - 1, sliceEnd);
      }
      content = sliceLines.join("\n");
      truncated = true;
    }
    const sectionTokens = estimateTokens(`--- ${relPath} (lines ${start}-${end}) ---\n${content}`);
    const remaining = CEILINGS.batchTokens - totalTokens;
    if (sectionTokens > remaining && sections.length > 0) {
      notes.push(`"${req.path}" skipped — batch token ceiling reached. Narrow the range or split into two calls.`);
      truncatedSections.push(relPath);
      continue;
    }
    sections.push({ path: relPath, startLine: start, endLine: end, content, readSha1: hashContent(source) });
    totalTokens += sectionTokens;
    if (truncated) truncatedSections.push(relPath);
  }

  return {
    sections,
    truncatedSections,
    ...(notes.length > 0 ? { note: notes.join("\n") } : {}),
  };
}

export const handler = readMultipleFilesTool;
