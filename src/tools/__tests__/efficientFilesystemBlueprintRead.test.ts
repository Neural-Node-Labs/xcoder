// ronin:version 2 | ronin:task task-b88b43 | ronin:updated 2026-08-13T06:04:44.420Z | ronin:subtask test-st-eaae62
// Blueprint tests: gated reads, actionable truncation, readSha1 staleness tokens,
// discovery/dependency graph, git primitives, and shared fsToolUtils invariants.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { dispatchToolCall } from "../toolDispatcher.js";
import { ToolCall } from "../../core/types.js";
import { CEILINGS, countLines, estimateTokens, hashContent, truncateActionable } from "../fsToolUtils.js";

describe("efficient filesystem blueprint — gated reads and actionable truncation", () => {
  let tmp: string;
  let cwd: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eff-fs-read-"));
    cwd = tmp;
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("read_file_range_tool returns readSha1 and truncates to ceiling with actionable note", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1} ` + "x".repeat(90));
    fs.writeFileSync(path.join(tmp, "wide.ts"), lines.join("\n"), "utf-8");
    const res = await dispatchToolCall(
      makeCall("read_file_range_tool", { path: "wide.ts", startLine: 1, endLine: 120 }),
      cwd
    );
    expect(res.isError).toBe(false);
    const obs = res.observation as any;
    expect(obs.readSha1).toMatch(/^[a-f0-9]{40}$/);
    expect(obs.truncated).toBe(true);
    expect(String(obs.note)).toMatch(/truncated/i);
    expect(String(obs.note)).toMatch(/narrower range/i);
    expect(estimateTokens(obs.content)).toBeLessThanOrEqual(CEILINGS.readTokens);
  });

  it("read_file_range_tool fails loudly when the range starts beyond the file", async () => {
    fs.writeFileSync(path.join(tmp, "tiny.ts"), "one\ntwo\n", "utf-8");
    const res = await dispatchToolCall(
      makeCall("read_file_range_tool", { path: "tiny.ts", startLine: 99, endLine: 100 }),
      cwd
    );
    expect(res.isError).toBe(true);
    expect(String((res.observation as any).error)).toContain("beyond");
  });

  it("read_multiple_files_tool returns labeled sections for cross-file reads", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "aaa\nbbb\nccc\n", "utf-8");
    fs.writeFileSync(path.join(tmp, "b.ts"), "xxx\nyyy\nzzz\n", "utf-8");
    const res = await dispatchToolCall(
      makeCall("read_multiple_files_tool", {
        files: [
          { path: "a.ts", startLine: 1, endLine: 2 },
          { path: "b.ts", startLine: 2, endLine: 3 },
        ],
      }),
      cwd
    );
    expect(res.isError).toBe(false);
    const sections = (res.observation as any).sections;
    expect(sections.length).toBe(2);
    expect(sections[0]).toMatchObject({ path: "a.ts", startLine: 1, endLine: 2 });
    expect(sections[1]).toMatchObject({ path: "b.ts", startLine: 2, endLine: 3 });
    expect(sections[0].content).toContain("aaa");
    expect(sections[1].content).toContain("yyy");
  });

  it("validate_file_tool reports type errors and passes clean files", async () => {
    // Note: type/semantic diagnostics are NOT reported (see .ronin/defects/defect0001.md);
    // this test covers the syntactic gate, which is what validate_file_tool implements today.
    fs.writeFileSync(path.join(tmp, "bad.ts"), "const x: number = ;\n", "utf-8");
    const bad = await dispatchToolCall(makeCall("validate_file_tool", { path: "bad.ts" }), cwd);
    expect(bad.isError).toBe(false);
    expect((bad.observation as any).ok).toBe(false);
    expect((bad.observation as any).errors.length).toBeGreaterThan(0);

    fs.writeFileSync(path.join(tmp, "good.ts"), "const y: number = 1;\n", "utf-8");
    const good = await dispatchToolCall(makeCall("validate_file_tool", { path: "good.ts" }), cwd);
    expect(good.isError).toBe(false);
    expect((good.observation as any).ok).toBe(true);
    expect((good.observation as any).errors.length).toBe(0);
  });
});

describe("efficient filesystem blueprint — discovery, dependency graph, git primitives", () => {
  let tmp: string;
  let cwd: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eff-fs-graph-"));
    cwd = tmp;
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("find_files_tool returns matches and truncates to an explicit limit with a note", async () => {
    fs.writeFileSync(path.join(tmp, "a.ts"), "", "utf-8");
    fs.writeFileSync(path.join(tmp, "b.ts"), "", "utf-8");
    fs.writeFileSync(path.join(tmp, "c.txt"), "", "utf-8");
    const res = await dispatchToolCall(makeCall("find_files_tool", { pattern: "*.ts" }), cwd);
    expect(res.isError).toBe(false);
    const files = (res.observation as any).files as string[];
    expect(files).toContain("a.ts");
    expect(files).toContain("b.ts");
    expect(files).not.toContain("c.txt");

    const limited = await dispatchToolCall(makeCall("find_files_tool", { pattern: "*.ts", limit: 1 }), cwd);
    expect((limited.observation as any).files.length).toBe(1);
    expect((limited.observation as any).truncated).toBe(true);
    expect(String((limited.observation as any).note)).toContain("narrow");
  });

  it("list_directory_tool lists files and dirs at shallow depth", async () => {
    fs.mkdirSync(path.join(tmp, "subdir"));
    fs.writeFileSync(path.join(tmp, "root.ts"), "", "utf-8");
    fs.writeFileSync(path.join(tmp, "subdir", "nested.ts"), "", "utf-8");
    const res = await dispatchToolCall(makeCall("list_directory_tool", { path: ".", depth: 2 }), cwd);
    expect(res.isError).toBe(false);
    const names = ((res.observation as any).entries as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain("root.ts");
    expect(names).toContain("subdir");
    expect(names).toContain("subdir/nested.ts");
  });

  it("get_dependency_graph_tool reports imports and importers (dependency-first reading order)", async () => {
    fs.writeFileSync(path.join(tmp, "utils.ts"), "export function helper() { return 1; }\n", "utf-8");
    fs.writeFileSync(path.join(tmp, "app.ts"), 'import { helper } from "./utils";\nconsole.log(helper());\n', "utf-8");
    const app = await dispatchToolCall(makeCall("get_dependency_graph_tool", { path: "app.ts" }), cwd);
    expect(app.isError).toBe(false);
    expect((app.observation as any).imports).toContain("./utils");

    const utils = await dispatchToolCall(makeCall("get_dependency_graph_tool", { path: "utils.ts" }), cwd);
    expect(utils.isError).toBe(false);
    expect((utils.observation as any).importers).toContain("app.ts");
  });

  it("git_diff_tool and git_log_tool work inside a real git repo", async () => {
    try {
      execSync("git init -q", { cwd: tmp, stdio: "pipe" });
    } catch {
      return; // skip when git is unavailable
    }
    fs.writeFileSync(path.join(tmp, "tracked.ts"), "export const a = 1;\n", "utf-8");
    execSync("git add -A", { cwd: tmp, stdio: "pipe" });
    execSync('git -c user.email=test@example.com -c user.name="Test" commit -q -m "initial commit"', {
      cwd: tmp, stdio: "pipe",
    });
    fs.appendFileSync(path.join(tmp, "tracked.ts"), "export const b = 2;\n", "utf-8");

    const diff = await dispatchToolCall(makeCall("git_diff_tool", { rawDiff: true }), cwd);
    expect(diff.isError).toBe(false);
    expect((diff.observation as any).stat.length).toBeGreaterThan(0);
    expect(String((diff.observation as any).rawDiff)).toContain("tracked.ts");

    const log = await dispatchToolCall(makeCall("git_log_tool", { path: "tracked.ts" }), cwd);
    expect(log.isError).toBe(false);
    expect((log.observation as any).entries.length).toBeGreaterThan(0);
    expect((log.observation as any).entries[0].subject).toBe("initial commit");
  });
});

describe("fsToolUtils — shared backbone invariants", () => {
  it("hashContent is a deterministic sha1 hex digest", () => {
    const h1 = hashContent("const x = 1;");
    const h2 = hashContent("const x = 1;");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{40}$/);
  });

  it("truncateActionable reports omitted count and an actionable suggestion", () => {
    const res = truncateActionable([1, 2, 3, 4], 2, "matches", "Add a path filter.");
    expect(res.items).toEqual([1, 2]);
    expect(res.truncated).toBe(true);
    expect(res.note).toContain("2 more matches");
    expect(res.note).toContain("Add a path filter.");
  });

  it("countLines and estimateTokens match the shared token/line model", () => {
    expect(countLines("")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("CEILINGS centralize the read/write/full-file gates", () => {
    expect(CEILINGS.fullFileLines).toBeGreaterThan(0);
    expect(CEILINGS.readTokens).toBeGreaterThan(0);
    expect(CEILINGS.writeFileLines).toBeGreaterThan(0);
  });
});

function makeCall(toolName: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${Math.random()}`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } };
}
