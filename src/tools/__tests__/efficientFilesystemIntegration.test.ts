// ronin:version 1 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:55:50.818Z | ronin:subtask code-st-5a7e6a
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TOOL_SCHEMAS } from "../toolSchemas.js";

const NEW_TOOL_NAMES = [
  "list_directory_tool", "find_files_tool", "get_dependency_graph_tool",
  "search_code_tool", "search_ast_tool", "read_outline_tool",
  "read_file_range_tool", "read_multiple_files_tool", "read_full_file_tool",
  "git_diff_tool", "git_log_tool", "search_replace_block_tool", "sed_replace_tool",
  "sed_replace_multi_tool", "line_patch_tool", "update_function_tool",
  "rename_symbol_tool", "apply_unified_diff_tool", "write_file_tool", "validate_file_tool",
];

const ROOT = path.resolve(__dirname, "../../..");

function readRoot(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}

describe("efficient filesystem integration", () => {
  it("every new tool has a schema and a dispatcher case", () => {
    const names = new Set(TOOL_SCHEMAS.map((s) => s.function.name));
    const dispatcherSource = readRoot("src/tools/toolDispatcher.ts");
    for (const name of NEW_TOOL_NAMES) {
      expect(names.has(name), `schema missing ${name}`).toBe(true);
      expect(dispatcherSource.includes(`case "${name}":`), `dispatcher case missing ${name}`).toBe(true);
    }
  });

  it("every new tool is listed in the filesystem skill requires_tools", () => {
    const skill = readRoot("agent/skills/filesystem-management/SKILL.md");
    for (const name of NEW_TOOL_NAMES) {
      expect(skill.includes(name), `SKILL.md requires_tools missing ${name}`).toBe(true);
    }
  });

  it("new read-only tools are in READ_ONLY_TOOLS sets and system prompts", () => {
    const readOnly = [
      "list_directory_tool", "find_files_tool", "get_dependency_graph_tool",
      "search_code_tool", "search_ast_tool", "read_outline_tool",
      "read_file_range_tool", "read_multiple_files_tool", "read_full_file_tool",
      "git_diff_tool", "git_log_tool", "validate_file_tool",
    ];
    const engineFiles = [
      "src/core/orchestrator.ts",
      "src/core/engine/LeanEngine.ts",
    ];
    for (const rel of engineFiles) {
      const src = readRoot(rel);
      for (const name of readOnly) {
        expect(src.includes(`"${name}"`), `${rel} missing ${name}`).toBe(true);
      }
    }
    // The three engines' system prompts mention the new discovery/search tools.
    for (const rel of ["src/core/orchestrator.ts", "src/core/engine/LeanEngine.ts", "src/core/engine/SimpleReactEngine.ts"]) {
      const src = readRoot(rel);
      expect(src).toContain("list_directory_tool");
    }
  });

  it("buildProtocolPrompt emits the EFFICIENT FILESYSTEM PROTOCOL block", async () => {
    const { buildProtocolPrompt } = await import("../../core/protocol.js");
    const prompt = buildProtocolPrompt(ROOT);
    expect(prompt).toContain("EFFICIENT FILESYSTEM PROTOCOL");
    expect(prompt).toContain("search_replace_block_tool");
    expect(prompt).toContain("line_patch_tool (always with expectedSha1)");
  });
});
