// ronin:version 3 | ronin:task task-b88b43 | ronin:updated 2026-08-13T05:52:32.185Z | ronin:subtask code-st-5a7e6a
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveConfinedPath } from "./workspaceConfinement.js";

/**
 * Shared filesystem/validation utilities for the Efficient Filesystem Agent (C3).
 * One implementation of path resolution, workspace confinement, sha1 hashing
 * (staleness), token/line ceilings, actionable truncation, and TS parsing.
 * Every new read/edit/validate tool calls these — no per-tool copy-paste.
 */

/**
 * Resolves a workspace-relative path against `cwd`, enforcing the same opt-in
 * confinement as the existing read_tool/write_edit_tool. Throws
 * WorkspaceEscapeError when confinement is enabled and the path escapes.
 */
export function resolveWorkspacePath(relPath: string, cwd: string): string {
  return resolveConfinedPath(relPath, cwd);
}

/** Stable cross-platform sha1 hex digest. */
export function hashContent(content: string): string {
  return crypto.createHash("sha1").update(content, "utf-8").digest("hex");
}

/** Reads the file at `relPath` (resolved against `cwd`) and hashes its content. */
export function hashFile(relPath: string, cwd: string): string {
  const full = resolveWorkspacePath(relPath, cwd);
  return hashContent(fs.readFileSync(full, "utf-8"));
}

/** All hard/soft ceilings live in one place and are tunable here. */
export const CEILINGS = {
  readTokens: 2000,
  batchTokens: 8000,
  listEntries: 1000,
  findFilesLimit: 200,
  searchMatches: 200,
  fullFileLines: 500,
  writeFileLines: 200,
  maxDepth: 4,
  maxContextLines: 5,
} as const;

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Truncates an array and, when truncation happened, returns an ACTIONABLE note
 * telling the model how to narrow the query. Caps are never silent.
 */
export function truncateActionable<T>(
  items: T[],
  ceiling: number,
  noun: string,
  suggestion: string
): { items: T[]; truncated: boolean; note?: string } {
  if (items.length <= ceiling) return { items, truncated: false };
  const omitted = items.length - ceiling;
  return {
    items: items.slice(0, ceiling),
    truncated: true,
    note: `[Output truncated: ${omitted} more ${noun}. ${suggestion}]`,
  };
}

/** True when the path looks like something ts-morph can parse. */
export function isTsJsExtension(file: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(file);
}

/** Reads a file's lines (split cross-platform), resolving against cwd. */
export function readFileLines(relPath: string, cwd: string): string[] {
  const full = resolveWorkspacePath(relPath, cwd);
  return fs.readFileSync(full, "utf-8").split(/\r?\n/);
}

/** 1-based inclusive line window. */
export function readLineWindow(relPath: string, cwd: string, startLine: number, endLine: number): string {
  const lines = readFileLines(relPath, cwd);
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, endLine);
  return lines.slice(start - 1, end).join("\n");
}

/** Counts lines in file content (an empty file is 1 line). */
export function countLines(content: string): number {
  if (content.length === 0) return 1;
  return content.split(/\r?\n/).length;
}

/** Normalizes a path for display inside observations (always forward slashes). */
export function normalizeDisplayPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * @deprecated use normalizeDisplayPath — kept as the friendly alias used across
 * the efficient-filesystem tool modules.
 */
export const displayPath = normalizeDisplayPath;

/** @deprecated use isTsJsExtension — kept as the friendly alias used across tools. */
export const isTsJsFile = isTsJsExtension;
