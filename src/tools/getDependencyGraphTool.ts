// ronin:version 2 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:46:28.245Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "./fsToolUtils.js";

export interface DependencyGraphResult {
  path: string;
  imports: string[];
  importers: string[];
  unresolvedImports?: string[];
  note?: string;
}

const IMPORT_RE = /(?:^|[;\n])\s*(?:import|export)\s+(?:type\s+|\{[^}]*\}\s+|.*?from\s+)?['"]\s*([^'"]+)['"]/g;

function extractImports(source: string): string[] {
  const imports: string[] = [];
  const re = new RegExp(IMPORT_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]?.trim();
    if (spec && !imports.includes(spec)) imports.push(spec);
  }
  return imports;
}

export async function getDependencyGraphTool(
  args: { path: string },
  cwd: string = process.cwd()
): Promise<DependencyGraphResult> {
  const relPath = args.path.replace(/\\/g, "/");
  const full = resolveWorkspacePath(relPath, cwd);
  let source: string;
  try {
    source = fs.readFileSync(full, "utf-8");
  } catch (err) {
    throw new Error(`Could not read "${relPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const imports = extractImports(source);
  const unresolvedImports = imports.filter((spec) => {
    const isRelative = spec.startsWith("./" ) || spec.startsWith("../");
    if (!isRelative) return false;
    const candidate = spec.replace(/\.[a-z]+$/i, "");
    const possible = [
      path.join(path.dirname(full), candidate),
      path.join(path.dirname(full), candidate + ".ts"),
      path.join(path.dirname(full), candidate + ".tsx"),
      path.join(path.dirname(full), candidate + ".js"),
      path.join(path.dirname(full), candidate, "index.ts"),
      path.join(path.dirname(full), candidate, "index.js"),
    ];
    return !possible.some((p) => fs.existsSync(p));
  });

  // Best-effort importer scan: grep every TS/JS file under cwd for relative paths
  // that point at the target file.
  const importers: string[] = [];
  const fg = (await import("fast-glob")).default;
  const ignore = (await import("../indexing/ignoreRules.js")).loadIgnoreRules(cwd);
  const dir = path.dirname(full);
  const base = path.basename(full).replace(/\.[^.]+$/, "");
  const files = await fg("**/*.{ts,tsx,js,jsx,mjs,cjs}", { cwd, ignore, dot: false, onlyFiles: true });
  for (const file of files) {
    if (file === relPath) continue;
    try {
      const content = fs.readFileSync(path.join(cwd, file), "utf-8");
      const relDir = path.posix.dirname(file);
      const needs = [
        "./" + base, "../" + base, "../.." + "/" + base, // crude, but best-effort
      ];
      const targetAbsVariants = [
        path.posix.join("/", relDir, "./", base),
      ];
      void targetAbsVariants;
      const normFull = full.replace(/\\/g, "/");
      const fromDir = path.posix.dirname("/" + file);
      const relTo = path.posix.relative(fromDir, normFull);
      if (needs.some((n) => content.includes(n)) || (content.includes(base) && relTo.split("/").length <= 3 && /from\s+['"]\.\.?\//.test(content))) {
        importers.push(file);
      }
    } catch {
      // skip unreadable file
    }
  }

  const result: DependencyGraphResult = {
    path: relPath,
    imports,
    importers,
  };
  if (unresolvedImports.length > 0) result.unresolvedImports = unresolvedImports;
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(relPath)) {
    result.note = "Best-effort scan — this file is not TypeScript/JavaScript so import extraction is heuristic.";
  }
  return result;
}

export const handler = getDependencyGraphTool;
