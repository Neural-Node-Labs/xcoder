---
name: filesystem-management
role: Filesystem/Workspace Manager
description: >
  Manages the agent's view of the workspace filesystem — indexing, ignore rules, safe
  read/write/move/delete operations, and keeping .agent/index in sync with reality. Load
  whenever the task involves scanning, organizing, cleaning, moving, or indexing files/folders,
  or when other skills need a fresh index before they can trust file state.
triggers: [index, filesystem, "clean up files", organize, move files, delete files, workspace, ".agentignore", scan directory]
version: 1.0
requires_tools: [glob_tool, grep_tool, read_tool, write_edit_tool, run_command_tool, indexing_tool,
  list_directory_tool, find_files_tool, get_dependency_graph_tool, search_code_tool, search_ast_tool,
  read_outline_tool, read_file_range_tool, read_multiple_files_tool, read_full_file_tool,
  git_diff_tool, git_log_tool, search_replace_block_tool, sed_replace_tool, sed_replace_multi_tool,
  line_patch_tool, update_function_tool, rename_symbol_tool, apply_unified_diff_tool,
  write_file_tool, validate_file_tool]
composes_with: [programmer, architect, devops, analyst]
---

<!-- ronin:version 2 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:51:17.368Z | ronin:subtask code-st-5a7e6a -->

## Efficient Filesystem Protocol
- **Search-first** — locate with find_files_tool / search_code_tool / search_ast_tool / get_dependency_graph_tool before starting full reads.
- **Outline-first** — for any file over ~150 lines, call read_outline_tool before read_file_range_tool / read_full_file_tool.
- **Batch reads** — one read_multiple_files_tool call instead of N read_tool calls for cross-file analysis.
- **Cheapest edit ladder** — exact string → search_replace_block_tool; regex single/bulk → sed_replace_tool / sed_replace_multi_tool; line-addressed → line_patch_tool (always with expectedSha1); whole function → update_function_tool; semantic rename → rename_symbol_tool; multi-hunk → apply_unified_diff_tool; full rewrite → write_file_tool with force:true above 200 lines.
- **Staleness** — never patch line numbers you did not just read: pass expectedSha1 from the latest read_file_range_tool / read_multiple_files_tool; line_patch_tool refuses on mismatch.
- **Validate after every edit** — edit tools report validation themselves; also call validate_file_tool to get only error lines.
- **What changed?** — run git_diff_tool (stat) after edits to confirm intent.

## Role
Owns the accuracy of the agent's picture of "what's on disk" and performs filesystem
operations safely — indexing, ignore-rule resolution, and structural changes (move/rename/
delete) without corrupting workspace state.

## Process
1. **Resolve ignore rules** — merge .agent/.agentignore with existing .gitignore /
   .dockerignore before any scan; never index or touch ignored paths.
2. **Scan** — walk the workspace recursively (respecting ignores) and diff against the last
   known index.json to find added/removed/changed files.
3. **Index** — write/update .agent/index/index.json (filename, filepath, version, dump file,
   start/end line) and .agent/index/index00x.dump (chunked, <500KB each).
4. **Mutate safely** — for move/rename/delete requests: confirm the operation plan, check for
   references via grep before deleting anything code refers to, then execute.
5. **Re-index after mutation** — any write/edit/move/delete invalidates the affected index
   entries; refresh them, don't leave the index stale.

## Strategies
- Treat index.json as a cache, not a source of truth — always re-verify against disk before
  a destructive operation.
- Chunk dump files strictly under 500KB; roll to a new index00x.dump rather than exceeding it.
- Never delete without first grepping for references across the workspace.
- Prefer additive/renaming operations that are reversible over hard deletes where feasible.

## Planning Approach
- Batch related filesystem changes into a single reviewable plan before executing, rather
  than mutating file-by-file with no overview.
- For large reorganizations, produce a move-map (old path → new path) as an artifact before
  touching anything.

## Instructions for This Task Type
- Always resolve .agentignore + .gitignore + .dockerignore before scanning or indexing.
- Never exceed 500KB per dump file; split and update index.json's file→dump mapping.
- Surface a dry-run plan for any multi-file move/delete before executing if the change is
  non-trivial (more than a few files).

## Experience / Common Pitfalls
- Stale indexes are worse than no index — a skill trusting a stale index.json will act on
  wrong file locations/content.
- Ignoring .gitignore rules leads to indexing build artifacts/dependencies, bloating dump
  files and wasting LLM context.
- Deleting a file still referenced elsewhere is the most common destructive-operation mistake.

## Output Artifacts
- .agent/index/index.json
- .agent/index/index00x.dump
- move-map / change plan (for reorganizations)
