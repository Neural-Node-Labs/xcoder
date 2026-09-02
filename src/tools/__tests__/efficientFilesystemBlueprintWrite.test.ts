// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T06:03:24.028Z | ronin:subtask test-st-eaae62
// Blueprint tests: layered write/edit toolset — soft write ceiling, exact-once search-replace,
// dry-run sed multi, line-range sed, unified diff, AST function update, reference-aware rename.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatchToolCall } from "../toolDispatcher.js";
import { ToolCall } from "../../core/types.js";

describe("efficient filesystem blueprint — write gating and layered edits", () => {
  let tmp: string;
  let cwd: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eff-fs-write-"));
    cwd = tmp;
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("write_file_tool refuses >200 lines without force, writes with force, and creates parent dirs", async () => {
    const content = Array.from({ length: 201 }, (_, i) => `// line ${i + 1}`).join("\n");
    const refused = await dispatchToolCall(
      makeCall("write_file_tool", { path: "deep/nested/big.ts", content }),
      cwd
    );
    expect(refused.isError).toBe(true);
    expect(String((refused.observation as any).error)).toContain("soft ceiling");
    expect(fs.existsSync(path.join(tmp, "deep", "nested", "big.ts"))).toBe(false);

    const forced = await dispatchToolCall(
      makeCall("write_file_tool", { path: "deep/nested/big.ts", content, force: true }),
      cwd
    );
    expect(forced.isError).toBe(false);
    expect((forced.observation as any).ceilingExceeded).toBe(true);
    expect(fs.readFileSync(path.join(tmp, "deep", "nested", "big.ts"), "utf-8")).toBe(content);
  });

  it("sed_replace_tool honors lineRange and reports replacementsApplied only inside it", async () => {
    fs.writeFileSync(path.join(tmp, "data.txt"), "old world\nold world\n", "utf-8");
    const res = await dispatchToolCall(
      makeCall("sed_replace_tool", {
        path: "data.txt", pattern: "old", replacement: "new", flags: "g",
        lineRange: { start: 1, end: 1 },
      }),
      cwd
    );
    expect(res.isError).toBe(false);
    expect((res.observation as any).replacementsApplied).toBe(1);
    expect(fs.readFileSync(path.join(tmp, "data.txt"), "utf-8")).toBe("new world\nold world\n");
  });

  it("sed_replace_multi_tool defaults to dry-run (zero writes) and applies only with dryRun:false", async () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "hello world", "utf-8");
    fs.writeFileSync(path.join(tmp, "b.txt"), "hello moon", "utf-8");

    const dry = await dispatchToolCall(
      makeCall("sed_replace_multi_tool", { globPattern: "*.txt", pattern: "hello", replacement: "goodbye" }),
      cwd
    );
    expect(dry.isError).toBe(false);
    expect((dry.observation as any).dryRun).toBe(true);
    expect((dry.observation as any).affectedFiles.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(tmp, "a.txt"), "utf-8")).toBe("hello world");

    const applied = await dispatchToolCall(
      makeCall("sed_replace_multi_tool", {
        globPattern: "*.txt", pattern: "hello", replacement: "goodbye", dryRun: false,
      }),
      cwd
    );
    expect(applied.isError).toBe(false);
    expect((applied.observation as any).dryRun).toBe(false);
    expect(fs.readFileSync(path.join(tmp, "a.txt"), "utf-8")).toBe("goodbye world");
    expect(fs.readFileSync(path.join(tmp, "b.txt"), "utf-8")).toBe("goodbye moon");
  });

  it("search_replace_block_tool applies a unique exact match, fails loud + zero writes when absent", async () => {
    fs.writeFileSync(path.join(tmp, "one.ts"), "const a = 1;\nconst b = 2;\n", "utf-8");
    const ok = await dispatchToolCall(
      makeCall("search_replace_block_tool", {
        path: "one.ts", searchBlock: "const a = 1;", replaceBlock: "const a = 42;",
      }),
      cwd
    );
    expect(ok.isError).toBe(false);
    expect(fs.readFileSync(path.join(tmp, "one.ts"), "utf-8")).toContain("const a = 42;");

    const before = fs.readFileSync(path.join(tmp, "one.ts"), "utf-8");
    const missing = await dispatchToolCall(
      makeCall("search_replace_block_tool", {
        path: "one.ts", searchBlock: "const zzz = 999;", replaceBlock: "const nope = 0;",
      }),
      cwd
    );
    expect(missing.isError).toBe(true);
    expect(String((missing.observation as any).error)).toContain("not found");
    expect(fs.readFileSync(path.join(tmp, "one.ts"), "utf-8")).toBe(before);
  });

  it("apply_unified_diff_tool applies a valid hunk and rejects mismatch with zero writes", async () => {
    fs.writeFileSync(path.join(tmp, "patch.txt"), "aaa\nbbb\nccc\n", "utf-8");
    const good = await dispatchToolCall(
      makeCall("apply_unified_diff_tool", {
        path: "patch.txt",
        diff: "--- a/patch.txt\n+++ b/patch.txt\n@@ -1,3 +1,3 @@\n-aaa\n+AAA\n bbb\n ccc\n",
      }),
      cwd
    );
    expect(good.isError).toBe(false);
    expect(fs.readFileSync(path.join(tmp, "patch.txt"), "utf-8")).toBe("AAA\nbbb\nccc\n");

    const before = fs.readFileSync(path.join(tmp, "patch.txt"), "utf-8");
    const bad = await dispatchToolCall(
      makeCall("apply_unified_diff_tool", {
        path: "patch.txt",
        diff: "--- a/patch.txt\n+++ b/patch.txt\n@@ -1,3 +1,3 @@\n-XXX\n+YYY\n bbb\n ccc\n",
      }),
      cwd
    );
    expect(bad.isError).toBe(true);
    expect(String((bad.observation as any).error)).toContain("does not match");
    expect(fs.readFileSync(path.join(tmp, "patch.txt"), "utf-8")).toBe(before);
  });

  it("update_function_tool rewrites via AST and refuses non-TS/JS files", async () => {
    fs.writeFileSync(
      path.join(tmp, "greet.ts"),
      "export function greet(name: string): string {\n  return `hello ${name}`;\n}\n",
      "utf-8"
    );
    const ok = await dispatchToolCall(
      makeCall("update_function_tool", {
        path: "greet.ts",
        functionName: "greet",
        newCode: "export function greet(name: string): string {\n  return `hi ${name}`;\n}",
      }),
      cwd
    );
    expect(ok.isError).toBe(false);
    expect(fs.readFileSync(path.join(tmp, "greet.ts"), "utf-8")).toContain("return `hi ${name}`;");

    fs.writeFileSync(path.join(tmp, "notes.txt"), "plain text", "utf-8");
    const refused = await dispatchToolCall(
      makeCall("update_function_tool", { path: "notes.txt", functionName: "x", newCode: "x" }),
      cwd
    );
    expect(refused.isError).toBe(true);
    expect(String((refused.observation as any).error)).toContain("only TS/JS");
  });

  it("rename_symbol_tool renames references but never string literals (not a blind sed)", async () => {
    fs.writeFileSync(
      path.join(tmp, "sym.ts"),
      "const foo = \"foo\";\nexport function useFoo() { return foo; }\n",
      "utf-8"
    );
    const res = await dispatchToolCall(
      makeCall("rename_symbol_tool", { path: "sym.ts", name: "foo", newName: "bar" }),
      cwd
    );
    expect(res.isError).toBe(false);
    const content = fs.readFileSync(path.join(tmp, "sym.ts"), "utf-8");
    expect(content).toContain("const bar = \"foo\";");
    expect(content).toContain("return bar;");
    expect(content).toContain("\"foo\"");

    fs.writeFileSync(path.join(tmp, "plain.txt"), "foo foo foo", "utf-8");
    const refused = await dispatchToolCall(
      makeCall("rename_symbol_tool", { path: "plain.txt", name: "foo", newName: "bar" }),
      cwd
    );
    expect(refused.isError).toBe(true);
    expect(String((refused.observation as any).error)).toContain("Never a blind sed");
  });
});

function makeCall(toolName: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${Math.random()}`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } };
}
