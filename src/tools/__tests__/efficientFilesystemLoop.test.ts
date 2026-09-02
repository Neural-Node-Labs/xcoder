// ronin:version 2 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:55:30.975Z | ronin:subtask code-st-5a7e6a
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatchToolCall } from "../toolDispatcher.js";
import { ToolCall } from "../../core/types.js";

describe("efficient filesystem end-to-end loop", () => {
  let tmp: string;
  let bigFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eff-fs-loop-"));
    bigFile = path.join(tmp, "worker.ts");
    const lines: string[] = [];
    for (let i = 1; i <= 620; i++) {
      if (i === 30) lines.push("export function greet(name: string): string {");
      else if (i === 31) lines.push("  return `hello ${name}`;");
      else if (i === 32) lines.push("}");
      else lines.push(`// filler line ${i}`);
    }
    fs.writeFileSync(bigFile, lines.join("\n"), "utf-8");
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("runs search → batched read → line patch → validate → git diff", async () => {
    // 1. search_code_tool
    const search = await dispatchToolCall(
      makeCall("search_code_tool", { pattern: "export function greet", globPattern: "worker.ts" }),
      tmp
    );
    expect(search.isError).toBe(false);
    const line = (search.observation as any).matches[0].line;
    expect(line).toBe(30);

    // 2. read_multiple_files_tool — two slices, never read_full_file_tool
    const read = await dispatchToolCall(
      makeCall("read_multiple_files_tool", {
        files: [
          { path: "worker.ts", startLine: 28, endLine: 32 },
          { path: "worker.ts", startLine: 5, endLine: 6 },
        ],
      }),
      tmp
    );
    expect(read.isError).toBe(false);
    const sections = (read.observation as any).sections;
    expect(sections.length).toBe(2);
    const sha = sections[0].readSha1;

    // 3. line_patch_tool with the section's readSha1
    const patch = await dispatchToolCall(
      makeCall("line_patch_tool", {
        path: "worker.ts",
        startLine: 30,
        endLine: 32,
        newContent: "export function greet(name: string): string {\n  return `hi ${name}`;\n}",
        expectedSha1: sha,
      }),
      tmp
    );
    expect(patch.isError).toBe(false);

    // 4. validate_file_tool (ok)
    const validate = await dispatchToolCall(makeCall("validate_file_tool", { path: "worker.ts" }), tmp);
    expect(validate.isError).toBe(false);
    expect((validate.observation as any).ok).toBe(true);
    expect((validate.observation as any).errors.length).toBe(0);

    // 5. git_diff_tool (stat shows the one-line change)
    const diff = await dispatchToolCall(makeCall("git_diff_tool", {}), tmp);
    expect(diff.isError).toBe(false);
    const obs = diff.observation as any;
    expect(Array.isArray(obs.stat)).toBe(true);
    const content = fs.readFileSync(bigFile, "utf-8");
    expect(content).toContain("return `hi ${name}`;");
  });
});

function makeCall(toolName: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${Math.random()}`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } };
}
