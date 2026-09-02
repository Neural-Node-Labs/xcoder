// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:54:56.344Z | ronin:subtask code-st-5a7e6a
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_SCHEMAS } from "../toolSchemas.js";
import { dispatchToolCall } from "../toolDispatcher.js";
import { ToolCall } from "../../core/types.js";

const NEW_TOOL_NAMES = [
  "list_directory_tool", "find_files_tool", "get_dependency_graph_tool",
  "search_code_tool", "search_ast_tool", "read_outline_tool",
  "read_file_range_tool", "read_multiple_files_tool", "read_full_file_tool",
  "git_diff_tool", "git_log_tool", "search_replace_block_tool", "sed_replace_tool",
  "sed_replace_multi_tool", "line_patch_tool", "update_function_tool",
  "rename_symbol_tool", "apply_unified_diff_tool", "write_file_tool", "validate_file_tool",
];

describe("efficient filesystem tools — registry and unit behavior", () => {
  let tmp: string;
  let bigFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eff-fs-misc-"));
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

  it("registers every new tool in TOOL_SCHEMAS", () => {
    const names = new Set(TOOL_SCHEMAS.map((s) => s.function.name));
    for (const name of NEW_TOOL_NAMES) expect(names.has(name), `missing ${name}`).toBe(true);
  });

  it("search_code_tool finds a function with context lines and matchCount", async () => {
    const res = await dispatchToolCall(
      makeCall("search_code_tool", { pattern: "export function greet", globPattern: "worker.ts", contextLines: 2 }),
      tmp
    );
    expect(res.isError).toBe(false);
    const obs = res.observation as any;
    expect(obs.matches.length).toBeGreaterThan(0);
    expect(obs.matches[0].file).toBe("worker.ts");
    expect(obs.matches[0].line).toBe(30);
    expect(obs.matches[0].context.length).toBeGreaterThan(0);
  });

  it("read_multiple_files_tool returns labeled sections with readSha1", async () => {
    const res = await dispatchToolCall(
      makeCall("read_multiple_files_tool", { files: [{ path: "worker.ts", startLine: 28, endLine: 34 }] }),
      tmp
    );
    expect(res.isError).toBe(false);
    const obs = res.observation as any;
    expect(obs.sections.length).toBe(1);
    expect(obs.sections[0].path).toBe("worker.ts");
    expect(obs.sections[0].readSha1).toMatch(/^[a-f0-9]{40}$/);
    expect(obs.sections[0].content).toContain("export function greet");
  });

  it("line_patch_tool refuses a stale expectedSha1 with zero writes", async () => {
    const res = await dispatchToolCall(
      makeCall("line_patch_tool", {
        path: "worker.ts", startLine: 30, endLine: 32,
        newContent: "export function greet(name: string): string {\n  return `hi ${name}`;\n}",
        expectedSha1: "0".repeat(40),
      }),
      tmp
    );
    expect(res.isError).toBe(true);
    expect(String((res.observation as any).error)).toContain("changed since you read it");
    expect(fs.readFileSync(bigFile, "utf-8")).toContain("return `hello ${name}`;");
  });

  it("line_patch_tool applies with the fresh readSha1 from read_multiple_files_tool", async () => {
    const read = await dispatchToolCall(
      makeCall("read_multiple_files_tool", { files: [{ path: "worker.ts", startLine: 30, endLine: 32 }] }),
      tmp
    );
    const sha = (read.observation as any).sections[0].readSha1;
    const res = await dispatchToolCall(
      makeCall("line_patch_tool", {
        path: "worker.ts", startLine: 30, endLine: 32,
        newContent: "export function greet(name: string): string {\n  return `hi ${name}`;\n}",
        expectedSha1: sha,
      }),
      tmp
    );
    expect(res.isError).toBe(false);
    expect(fs.readFileSync(bigFile, "utf-8")).toContain("return `hi ${name}`;");
  });

  it("validate_file_tool returns only error lines and ok:true after valid line patch", async () => {
    const read = await dispatchToolCall(
      makeCall("read_multiple_files_tool", { files: [{ path: "worker.ts", startLine: 30, endLine: 32 }] }),
      tmp
    );
    const sha = (read.observation as any).sections[0].readSha1;
    await dispatchToolCall(
      makeCall("line_patch_tool", {
        path: "worker.ts", startLine: 30, endLine: 32,
        newContent: "export function greet(name: string): string {\n  return `hi ${name}`;\n}",
        expectedSha1: sha,
      }),
      tmp
    );
    const res = await dispatchToolCall(makeCall("validate_file_tool", { path: "worker.ts" }), tmp);
    expect(res.isError).toBe(false);
    expect((res.observation as any).ok).toBe(true);
    expect(Array.isArray((res.observation as any).errors)).toBe(true);
  });

  it("read_full_file_tool refuses >500 lines unless allowLarge", async () => {
    const res = await dispatchToolCall(makeCall("read_full_file_tool", { path: "worker.ts" }), tmp);
    expect(res.isError).toBe(true);
    expect(String((res.observation as any).error)).toContain("read_outline_tool");
    const ok = await dispatchToolCall(makeCall("read_full_file_tool", { path: "worker.ts", allowLarge: true }), tmp);
    expect(ok.isError).toBe(false);
    expect((ok.observation as any).lineCount).toBe(620);
  });

  it("read_outline_tool returns the function declaration with body", async () => {
    const res = await dispatchToolCall(makeCall("read_outline_tool", { path: "worker.ts" }), tmp);
    expect(res.isError).toBe(false);
    const obs = res.observation as any;
    expect(obs.lineCount).toBe(620);
    const fn = obs.outline.find((e: any) => e.name === "greet");
    expect(fn).toBeDefined();
    expect(fn.hasBody).toBe(true);
  });

  it("search_ast_tool finds the function declaration via ts-morph", async () => {
    const res = await dispatchToolCall(makeCall("search_ast_tool", { query: "function greet", pathGlob: "worker.ts" }), tmp);
    expect(res.isError).toBe(false);
    const obs = res.observation as any;
    expect(obs.parserUsed).toBe("ts-morph");
    expect(obs.nodes.length).toBeGreaterThan(0);
    expect(obs.nodes[0].name).toBe("greet");
  });

  it("search_replace_block_tool refuses non-unique with zero writes", async () => {
    const res = await dispatchToolCall(
      makeCall("search_replace_block_tool", { path: "worker.ts", searchBlock: "// filler line", replaceBlock: "// changed" }),
      tmp
    );
    expect(res.isError).toBe(true);
    expect(String((res.observation as any).error)).toContain("not unique");
  });

  it("sed_replace_multi_tool dry-run reports matches without writing", async () => {
    const res = await dispatchToolCall(
      makeCall("sed_replace_multi_tool", { globPattern: "worker.ts", pattern: "filler line 1", replacement: "changed", dryRun: true }),
      tmp
    );
    expect(res.isError).toBe(false);
    const obs = res.observation as any;
    expect(obs.dryRun).toBe(true);
    expect(obs.affectedFiles[0].matches).toBeGreaterThan(0);
    expect(fs.readFileSync(bigFile, "utf-8")).toContain("filler line 1");
  });
});

function makeCall(toolName: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${Math.random()}`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } };
}
