import fs from "node:fs";
import { globTool } from "./globTool.js";

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export async function grepTool(
  regex: string,
  globPattern: string = "**/*",
  cwd: string = process.cwd()
): Promise<GrepMatch[]> {
  const files = await globTool(globPattern, cwd);
  const re = new RegExp(regex);
  const matches: GrepMatch[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(`${cwd}/${file}`, "utf-8");
    } catch {
      continue; // binary or unreadable file — skip
    }
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      if (re.test(line)) {
        matches.push({ file, line: idx + 1, text: line.trim() });
      }
    });
  }
  return matches;
}


