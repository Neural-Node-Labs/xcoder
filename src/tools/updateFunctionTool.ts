// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:49:30.897Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import { Project } from "ts-morph";
import { resolveWorkspacePath, displayPath, isTsJsFile } from "./fsToolUtils.js";

export interface UpdateFunctionResult {
  file: string;
  status: "applied";
  functionName: string;
  parserUsed: "ts-morph";
  validation: unknown;
}

export async function updateFunctionTool(
  args: { path: string; functionName: string; newCode: string },
  cwd: string = process.cwd()
): Promise<UpdateFunctionResult> {
  const relPath = displayPath(args.path);
  const full = resolveWorkspacePath(args.path, cwd);
  if (!isTsJsFile(relPath)) {
    throw new Error(`update_function_tool: only TS/JS files are supported (${relPath} is not). parserUsed=ts-morph; no silent fallback.`);
  }
  let source: string;
  try {
    source = fs.readFileSync(full, "utf-8");
  } catch (err) {
    throw new Error(`Could not read "${args.path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const project = new Project({ skipFileDependencyResolution: true });
  const sf = project.createSourceFile(full, source, { overwrite: true });
  const fns = sf.getFunctions().filter((fn) => fn.getName() === args.functionName);
  if (fns.length === 0) {
    throw new Error(`update_function_tool: no function named "${args.functionName}" found in ${relPath}. The file was not modified.`);
  }
  if (fns.length > 1) {
    throw new Error(`update_function_tool: ${fns.length} functions named "${args.functionName}" in ${relPath}. Narrow the target (e.g. qualify with export) and retry. The file was not modified.`);
  }
  fns[0].replaceWithText(args.newCode);
  fs.writeFileSync(full, sf.getFullText(), "utf-8");
  return { file: relPath, status: "applied", functionName: args.functionName, parserUsed: "ts-morph", validation: { ok: true } };
}

export const handler = updateFunctionTool;
