// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:47:12.656Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import path from "node:path";
import { Project } from "ts-morph";
import { resolveWorkspacePath, isTsJsFile } from "./fsToolUtils.js";

interface OutlineEntry {
  kind: string;
  name: string;
  line: number;
  signature: string;
  hasBody: boolean;
}

export interface ReadOutlineResult {
  path: string;
  lineCount: number;
  language: string;
  outline: OutlineEntry[];
}

function signatureOf(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ").slice(0, 200);
}

export function readOutlineTool(
  args: { path: string },
  cwd: string = process.cwd()
): ReadOutlineResult {
  const relPath = args.path.replace(/\\/g, "/");
  const full = resolveWorkspacePath(relPath, cwd);
  let source: string;
  try {
    source = fs.readFileSync(full, "utf-8");
  } catch (err) {
    throw new Error(`Could not read "${relPath}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const lineCount = source.split(/\r?\n/).length;
  const language = path.extname(relPath).replace(/^\./, "") || "text";
  const outline: OutlineEntry[] = [];

  if (isTsJsFile(relPath)) {
    try {
      const project = new Project({ skipFileDependencyResolution: true });
      const sf = project.createSourceFile(full, source, { overwrite: true });
      for (const fn of sf.getFunctions()) {
        outline.push({
          kind: "function",
          name: fn.getName() ?? "anonymous",
          line: fn.getStartLineNumber(),
          signature: signatureOf(fn.getText().split("\n").slice(0, 2).join("\n")),
          hasBody: fn.getBody() !== undefined,
        });
      }
      for (const cls of sf.getClasses()) {
        outline.push({
          kind: "class",
          name: cls.getName() ?? "",
          line: cls.getStartLineNumber(),
          signature: signatureOf(cls.getText().split("\n").slice(0, 4).join("\n")),
          hasBody: cls.getMembers().length > 0,
        });
      }
      for (const ifc of sf.getInterfaces()) {
        outline.push({
          kind: "interface",
          name: ifc.getName() ?? "",
          line: ifc.getStartLineNumber(),
          signature: signatureOf(ifc.getText().split("\n").slice(0, 4).join("\n")),
          hasBody: ifc.getMembers().length > 0,
        });
      }
    } catch {
      // fall through to regex fallback below
    }
  }

  if (outline.length === 0) {
    const lines = source.split(/\r?\n/);
    const re = /^(export\s+)?(async\s+|class\s+|function\s+|interface\s+|type\s+|const\s+|let\s+|var\s+)/;
    lines.forEach((line, idx) => {
      if (re.test(line.trim())) {
        outline.push({
          kind: line.trim().startsWith("export") ? lines[idx + 1]?.trim()?.split(/\s+/)?.[0] ?? "declaration" : line.trim().split(/\s+/)[0] ?? "declaration",
          name: line.trim().split(/[\s(:=<{]+/)[1] ?? "",
          line: idx + 1,
          signature: signatureOf(line),
          hasBody: /[{\s(]$/.test(line.trim()),
        });
      } else if (/^(#{1,4}\s|##\s)/.test(line.trim())) {
        outline.push({ kind: "heading", name: line.trim(), line: idx + 1, signature: line.trim(), hasBody: false });
      }
    });
  }

  return { path: relPath, lineCount, language, outline: outline.slice(0, 200) };
}

export const handler = readOutlineTool;
