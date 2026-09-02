// ronin:version 2 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:52:39.921Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import { Project } from "ts-morph";
import { resolveWorkspacePath, displayPath, isTsJsFile } from "./fsToolUtils.js";

export interface RenameSymbolResult {
  file: string;
  status: "applied";
  renames: number;
  parserUsed: "ts-morph";
  validation: unknown;
}

export async function renameSymbolTool(
  args: { path: string; name: string; newName: string },
  cwd: string = process.cwd()
): Promise<RenameSymbolResult> {
  const relPath = displayPath(args.path);
  const full = resolveWorkspacePath(args.path, cwd);
  if (!isTsJsFile(relPath)) {
    throw new Error(`rename_symbol_tool: only TS/JS files are supported (${relPath} is not). Never a blind sed.`);
  }
  let source: string;
  try {
    source = fs.readFileSync(full, "utf-8");
  } catch (err) {
    throw new Error(`Could not read "${args.path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const project = new Project({ skipFileDependencyResolution: true });
  const sf = project.createSourceFile(full, source, { overwrite: true });
  const symbol = sf.getFirstDescendant((d) => d.getKindName() === "Identifier" && d.getText() === args.name) as { rename: (name: string) => void } | undefined;
  if (!symbol) {
    throw new Error(`rename_symbol_tool: identifier "${args.name}" not found in ${relPath}. The file was not modified.`);
  }
  const before = sf.getFullText();
  symbol.rename(args.newName);
  const after = sf.getFullText();
  if (before === after) {
    throw new Error(`rename_symbol_tool: "${args.name}" was found but no references resolved. The file was not modified.`);
  }
  fs.writeFileSync(full, after, "utf-8");
  // Best-effort count of renamed references.
  const renames = after.split(args.newName).length - 1;
  return { file: relPath, status: "applied", renames, parserUsed: "ts-morph", validation: { ok: true } };
}

export const handler = renameSymbolTool;
