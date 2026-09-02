import fs from "node:fs";
import path from "node:path";
import { resolveConfinedPath } from "./workspaceConfinement.js";

export interface EditResult {
  file: string;
  bytesWritten: number;
}

export function writeFile(filePath: string, content: string, cwd: string = process.cwd()): EditResult {
  const full = resolveConfinedPath(filePath, cwd);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return { file: full, bytesWritten: Buffer.byteLength(content, "utf-8") };
}

/** Simple exact-match replace, mirrors str_replace semantics: old must be unique. */
export function editFile(filePath: string, oldStr: string, newStr: string, cwd: string = process.cwd()): EditResult {
  const full = resolveConfinedPath(filePath, cwd);
  const content = fs.readFileSync(full, "utf-8");

  const occurrences = content.split(oldStr).length - 1;
  if (occurrences === 0) throw new Error(`editFile: old string not found in ${filePath}`);
  if (occurrences > 1) throw new Error(`editFile: old string is not unique in ${filePath} (${occurrences} matches)`);

  const updated = content.replace(oldStr, newStr);
  fs.writeFileSync(full, updated, "utf-8");
  return { file: full, bytesWritten: Buffer.byteLength(updated, "utf-8") };
}


