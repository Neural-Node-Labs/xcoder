import fs from "node:fs";
import path from "node:path";
import { resolveConfinedPath } from "./workspaceConfinement.js";

export function readTool(filePath: string, cwd: string = process.cwd()): string {
  const full = resolveConfinedPath(filePath, cwd);
  return fs.readFileSync(full, "utf-8");
}


