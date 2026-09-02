// ronin:version 2 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:47:02.865Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { Project, SyntaxKind } from "ts-morph";
import { loadIgnoreRules } from "../indexing/ignoreRules.js";
import { CEILINGS, isTsJsFile, truncateActionable, resolveWorkspacePath } from "./fsToolUtils.js";

interface AstNode {
  file: string;
  nodeType: string;
  name: string;
  line: number;
  snippet: string;
}

export interface SearchAstResult {
  nodes: AstNode[];
  matchCount: number;
  parserUsed: "ts-morph" | "regex";
  note?: string;
}

const QUERY_RE = /^(function|class|interface|type|enum|const|let|var|calls)\s*:?\s*(.*)$/;

function snippetOf(source: string, line: number, spanLines = 2): string {
  const lines = source.split(/\r?\n/);
  const start = Math.max(0, line - 1);
  const end = Math.min(lines.length, start + spanLines);
  return lines.slice(start, end).join("\n");
}

function regexFallback(args: { query: string; pathGlob?: string }, cwd: string): AstNode[] {
  const nodes: AstNode[] = [];
  const m = QUERY_RE.exec(args.query);
  const kind = m?.[1] ?? "function";
  const name = (m?.[2] ?? "").trim();
  let re: RegExp;
  if (kind === "calls") {
    re = new RegExp(`\\b${name || "[\\w]+"}\\s*\\(`, "g");
  } else {
    re = new RegExp(`\\b${kind}\\s+${name ? name + "\\b" : "[A-Za-z0-9_]+"}`, "g");
  }
  const allFiles = fg.sync(args.pathGlob ?? "**/*", { cwd, dot: false, onlyFiles: true, ignore: loadIgnoreRules(cwd) });
  for (const file of allFiles) {
    const full = path.join(cwd, file);
    let source: string;
    try {
      source = fs.readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    re.lastIndex = 0;
    let m2: RegExpExecArray | null;
    while ((m2 = re.exec(source)) !== null && nodes.length < CEILINGS.searchMatches) {
      const line = source.slice(0, m2.index).split(/\r?\n/).length;
      nodes.push({
        file,
        nodeType: kind === "calls" ? "call" : kind,
        name: name || (m2[0].split(/\s+/).pop() ?? "").replace(/\W/g, ""),
        line,
        snippet: snippetOf(source, line),
      });
    }
  }
  return nodes;
}

export async function searchAstTool(
  args: { query: string; pathGlob?: string },
  cwd: string = process.cwd()
): Promise<SearchAstResult> {
  const files = await fg(args.pathGlob ?? "**/*.{ts,tsx,js,jsx,mjs,cjs}", {
    cwd,
    ignore: loadIgnoreRules(cwd),
    dot: false,
    onlyFiles: true,
  }).catch(() => []);
  const tsFiles = files.filter(isTsJsFile);
  const nodes: AstNode[] = [];
  let parserUsed: "ts-morph" | "regex" = "ts-morph";
  let fallbackNeeded = false;

  const m = QUERY_RE.exec(args.query);
  const kind = m?.[1] ?? "function";
  const target = (m?.[2] ?? "").trim();

  try {
    if (tsFiles.length === 0) throw new Error("no TS/JS files");
    const project = new Project({
      skipFileDependencyResolution: true,
      compilerOptions: { allowJs: true, checkJs: false },
    });
    project.addSourceFilesAtPaths(tsFiles.map((f) => path.join(cwd, f)));
    for (const sourceFile of project.getSourceFiles()) {
      const file = path.relative(cwd, sourceFile.getFilePath()).replace(/\\/g, "/");
      if (pathGlobExcludes(file, args.pathGlob)) continue;
      const declarations = kind === "calls" ? sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression) : sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration);
      if (kind === "class") {
        for (const cls of sourceFile.getClasses()) {
          if (!target || cls.getName() === target) {
            nodes.push({
              file,
              nodeType: "class",
              name: cls.getName() ?? "",
              line: cls.getStartLineNumber(),
              snippet: snippetOf(sourceFile.getFullText(), cls.getStartLineNumber()),
            });
          }
        }
      } else if (kind === "interface") {
        for (const ifc of sourceFile.getInterfaces()) {
          if (!target || ifc.getName() === target) {
            nodes.push({
              file,
              nodeType: "interface",
              name: ifc.getName() ?? "",
              line: ifc.getStartLineNumber(),
              snippet: snippetOf(sourceFile.getFullText(), ifc.getStartLineNumber()),
            });
          }
        }
      } else if (kind === "calls") {
        for (const call of declarations as import("ts-morph").CallExpression[]) {
          const exprText = call.getExpression().getText();
          const name = exprText.split(".").pop() ?? exprText;
          if (!target || name === target) {
            nodes.push({
              file,
              nodeType: "call",
              name,
              line: call.getStartLineNumber(),
              snippet: snippetOf(sourceFile.getFullText(), call.getStartLineNumber()),
            });
          }
        }
      } else {
        for (const fn of sourceFile.getFunctions()) {
          if (!target || (fn.getName() ?? "") === target) {
            nodes.push({
              file,
              nodeType: "function",
              name: fn.getName() ?? "",
              line: fn.getStartLineNumber(),
              snippet: snippetOf(sourceFile.getFullText(), fn.getStartLineNumber()),
            });
          }
        }
        for (const v of sourceFile.getVariableDeclarations()) {
          if ((kind === "const" || kind === "let" || kind === "var") && (!target || v.getName() === target)) {
            nodes.push({
              file,
              nodeType: "variable",
              name: v.getName(),
              line: v.getStartLineNumber(),
              snippet: snippetOf(sourceFile.getFullText(), v.getStartLineNumber()),
            });
          }
        }
      }
      if (nodes.length >= CEILINGS.searchMatches) break;
    }
  } catch {
    parserUsed = "regex";
    fallbackNeeded = true;
  }

  if ((nodes.length === 0 || fallbackNeeded) && !tsFiles.length) {
    parserUsed = "regex";
    nodes.push(...regexFallback(args, cwd));
  }

  const res = truncateActionable(nodes, CEILINGS.searchMatches, "nodes", "Add a more specific query or pathGlob to narrow the search.");
  const result: SearchAstResult = {
    nodes: res.items as AstNode[],
    matchCount: nodes.length,
    parserUsed,
  };
  if (parserUsed === "regex") result.note = "parserUsed=regex: structural precision not guaranteed — this is a regex fallback for non-TS/JS files or parse failure.";
  if (res.note) result.note = result.note ? `${result.note} ${res.note}` : res.note;
  return result;
}

function pathGlobExcludes(file: string, globPattern?: string): boolean {
  if (!globPattern) return false;
  const re = new RegExp("^" + globPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
  return !re.test(file) && !re.test(file.split("/").pop() ?? file);
}

export const handler = searchAstTool;
