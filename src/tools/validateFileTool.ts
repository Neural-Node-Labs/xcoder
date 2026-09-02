// ronin:version 2 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:48:23.062Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { resolveWorkspacePath, displayPath } from "./fsToolUtils.js";

interface ValidateError {
  line: number;
  message: string;
}

export interface ValidateFileResult {
  file: string;
  ok: boolean;
  errors: ValidateError[];
  note?: string;
}

export function validateFileTool(
  args: { path: string; lang?: string },
  cwd: string = process.cwd()
): ValidateFileResult {
  const relPath = displayPath(args.path);
  const full = resolveWorkspacePath(args.path, cwd);
  let source: string;
  try {
    source = fs.readFileSync(full, "utf-8");
  } catch (err) {
    throw new Error(`Could not read "${args.path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const ext = path.extname(relPath).toLowerCase();
  const lang = (args.lang ?? ext.replace(/^\./, "")).toLowerCase();

  if (lang === "ts" || lang === "tsx" || lang === "js" || lang === "jsx" || ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    const fileName = path.basename(full);
    const scriptKind = ext === ".tsx" || ext === ".jsx" ? ts.ScriptKind.TSX : ext === ".ts" ? ts.ScriptKind.TS : ext === ".js" ? ts.ScriptKind.JS : ts.ScriptKind.JS;
    const out = ts.transpileModule(source, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, allowJs: true, checkJs: false, jsx: ts.JsxEmit.Preserve },
      ...(scriptKind ? { reportDiagnostics: true, fileName } : {}),
    });
    const errors: ValidateError[] = [];
    for (const d of (out.diagnostics ?? [])) {
      if (d.start !== undefined) {
        const pos = ts.getLineAndCharacterOfPosition(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind), d.start);
        errors.push({ line: pos.line + 1, message: ts.flattenDiagnosticMessageText(d.messageText, " ") });
      } else {
        errors.push({ line: 0, message: ts.flattenDiagnosticMessageText(d.messageText, " ") });
      }
    }
    if (errors.length > 0) return { file: relPath, ok: false, errors };
    return { file: relPath, ok: true, errors };
  }

  if (lang === "json") {
    try {
      JSON.parse(source);
      return { file: relPath, ok: true, errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const line = extractJsonErrorLine(message, source);
      return { file: relPath, ok: false, errors: [{ line, message }] };
    }
  }

  return { file: relPath, ok: true, errors: [], note: "no checker available for this language" };
}

function extractJsonErrorLine(message: string, source: string): number {
  const m = /position (\d+)/.exec(message);
  if (!m) return 1;
  const pos = Number(m[1]);
  const before = source.slice(0, pos);
  return before.split(/\r?\n/).length;
}

export const handler = validateFileTool;
