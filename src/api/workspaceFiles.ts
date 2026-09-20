import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { EXCLUDED } from "../core/workspaceManager.js";

/**
 * Backend for the Workspace file browser page (list/read/write/create/delete files within a
 * project). Deliberately does NOT reuse tools/workspaceConfinement.ts's resolveConfinedPath() —
 * that confinement is opt-in (XCODER_RESTRICT_TO_WORKSPACE, off by default) because the LLM
 * agent is explicitly trusted with full shell/file access by design. This module is different:
 * it's driven directly by a human clicking around a specific project in the browser, so
 * confinement to that project's root is not optional here — a path-traversal escape would let
 * any authenticated user read/write/delete files anywhere the server process can reach,
 * regardless of which project they claim to be looking at.
 */

export class WorkspacePathEscapeError extends Error {
  constructor(relPath: string) {
    super(`Refused: "${relPath}" resolves outside the project workspace.`);
    this.name = "WorkspacePathEscapeError";
  }
}

export class WorkspaceFileTooLargeError extends Error {
  constructor(relPath: string, maxBytes: number) {
    super(`Refused: "${relPath}" is larger than the ${Math.round(maxBytes / 1024 / 1024)}MB limit for viewing/editing in the browser.`);
    this.name = "WorkspaceFileTooLargeError";
  }
}

export class WorkspaceBinaryFileError extends Error {
  constructor(relPath: string) {
    super(`Refused: "${relPath}" looks like a binary file, not text — this editor only handles text files.`);
    this.name = "WorkspaceBinaryFileError";
  }
}

export class WorkspaceZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceZipError";
  }
}

const MAX_READ_BYTES = 5 * 1024 * 1024; // 5MB — generous for source files, small enough to stay snappy in a <textarea>

/** Always-enforced confinement, unconditionally — unlike resolveConfinedPath(). Rejects any
 *  relPath (after resolving "..", symlinked components aren't followed specially here since
 *  we're not chasing symlinks, just resolving the literal path string) that would land outside
 *  `root`. Also rejects absolute paths outright — every relPath from the UI is expected to be
 *  project-relative, so an absolute path is itself a sign something's wrong upstream. */
function resolveInWorkspace(root: string, relPath: string): string {
  const cleaned = (relPath || ".").replace(/^\/+/, ""); // tolerate an accidental leading slash from the client
  if (path.isAbsolute(relPath)) throw new WorkspacePathEscapeError(relPath);

  const resolvedRoot = path.resolve(root);
  const resolvedFull = path.resolve(resolvedRoot, cleaned);
  const relative = path.relative(resolvedRoot, resolvedFull);

  const escapes = relative.startsWith("..") || path.isAbsolute(relative);
  if (escapes) throw new WorkspacePathEscapeError(relPath);

  return resolvedFull;
}

export interface WorkspaceFileEntry {
  name: string;
  /** Path relative to the project root, using forward slashes regardless of host OS. */
  path: string;
  type: "file" | "dir";
  size?: number;
  modifiedAt?: string;
}

/** Lists one directory's immediate children (not recursive — the frontend fetches lazily as the
 *  user expands folders), skipping the same names xcoder's own zip/index routes already treat
 *  as noise (node_modules, .git, dist, build, the isolated workspace-agent copy, .agent). */
export function listWorkspaceDirectory(root: string, relPath = "."): WorkspaceFileEntry[] {
  const full = resolveInWorkspace(root, relPath);
  if (!fs.existsSync(full)) return [];
  if (!fs.statSync(full).isDirectory()) throw new Error(`Not a directory: ${relPath}`);

  const entries = fs.readdirSync(full, { withFileTypes: true });
  const results: WorkspaceFileEntry[] = [];
  for (const entry of entries) {
    if (EXCLUDED.has(entry.name)) continue;
    const entryRelPath = path.join(relPath === "." ? "" : relPath, entry.name).split(path.sep).join("/");
    const entryFull = path.join(full, entry.name);
    if (entry.isDirectory()) {
      results.push({ name: entry.name, path: entryRelPath, type: "dir" });
    } else if (entry.isFile()) {
      const stat = fs.statSync(entryFull);
      results.push({ name: entry.name, path: entryRelPath, type: "file", size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
    // symlinks and other special file types are silently skipped — nothing safe to do with them
    // in a plain file browser, and following them risks stepping outside the workspace anyway.
  }
  // directories first, then alphabetical — matches how every familiar file explorer sorts.
  results.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return results;
}

/** Reads a file as UTF-8 text. Refuses anything over MAX_READ_BYTES or that looks binary (a
 *  null byte in the first 8KB is the same heuristic `file`/git use to guess binary vs text). */
export function readWorkspaceFile(root: string, relPath: string): { content: string; size: number } {
  const full = resolveInWorkspace(root, relPath);
  const stat = fs.statSync(full); // throws ENOENT naturally if missing — caller maps to 404
  if (!stat.isFile()) throw new Error(`Not a file: ${relPath}`);
  if (stat.size > MAX_READ_BYTES) throw new WorkspaceFileTooLargeError(relPath, MAX_READ_BYTES);

  const buf = fs.readFileSync(full);
  const sniffLen = Math.min(buf.length, 8192);
  if (buf.subarray(0, sniffLen).includes(0)) throw new WorkspaceBinaryFileError(relPath);

  return { content: buf.toString("utf-8"), size: stat.size };
}

/** Creates or overwrites a text file, creating any missing parent directories. */
export function writeWorkspaceFile(root: string, relPath: string, content: string): void {
  const full = resolveInWorkspace(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
}

/** Creates an empty directory (and any missing parents). No-op if it already exists. */
export function createWorkspaceDirectory(root: string, relPath: string): void {
  const full = resolveInWorkspace(root, relPath);
  fs.mkdirSync(full, { recursive: true });
}

/** Deletes a file or a directory (recursively). Refuses to delete the project root itself
 *  (relPath resolving to "." / "") — that's what "Remove project" on the Projects page is for,
 *  and doing it here would be a single misclick nuking an entire workspace with no confirmation
 *  beyond whatever the frontend prompts. */
export function deleteWorkspacePath(root: string, relPath: string): void {
  const full = resolveInWorkspace(root, relPath);
  const resolvedRoot = path.resolve(root);
  if (path.resolve(full) === resolvedRoot) {
    throw new Error("Refused: use the Projects page to remove an entire project, not the file browser.");
  }
  fs.rmSync(full, { recursive: true, force: true });
}

// ─── Zip upload + extract ───────────────────────────────────────────────────

// Limits sized for "someone drops a repo or a folder of assets into their project", not for
// hosting an untrusted file-sharing service. All three exist for the same reason: a zip is a
// small, attacker-controllable set of instructions for how much disk/memory to consume when
// decompressed, so refusing before extracting starts is the only point these are actually
// enforceable — once bytes are on disk the damage is already done.
const MAX_ZIP_ENTRIES = 5_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024; // 500MB
const MAX_SINGLE_FILE_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100MB
// A ratio this extreme (mostly repeated bytes compressing near-perfectly) is the classic
// zip-bomb signature rather than anything a normal source/asset archive produces. Only checked
// once an entry is already large enough (see below) so it doesn't false-positive on small,
// legitimately-compressible files like a minified JS bundle or a tiny all-zeros config file.
const SUSPICIOUS_COMPRESSION_RATIO = 200;
const RATIO_CHECK_FLOOR_BYTES = 1024 * 1024; // only ratio-check entries bigger than 1MB

export interface WorkspaceZipExtractResult {
  filesExtracted: number;
  dirsCreated: number;
  bytesWritten: number;
  /** Entries present in the zip but not written to disk, with why — excluded-dir contents
   *  (node_modules, .git, etc.), and nothing else: every other rejection reason aborts the
   *  whole extraction instead (see extractZipIntoWorkspace's doc comment). */
  skipped: string[];
}

/**
 * Extracts a zip file's contents into `targetRelPath` inside the workspace. All-or-nothing: if
 * any entry fails validation (path escape, oversized, exceeds the total budget), the whole
 * extraction is refused before anything is written — a half-extracted archive is a worse outcome
 * than a clear upfront error, since the user would otherwise need to manually figure out what
 * did and didn't make it onto disk. The one exception is EXCLUDED directory contents
 * (node_modules, .git, dist, …), which are silently skipped rather than aborting the whole
 * upload — extracting a checked-in repo zip that happens to include node_modules should still
 * work, it just shouldn't reproduce the noise the file browser already hides everywhere else.
 *
 * Zip-slip protection: every entry's path is resolved and confined through the exact same
 * resolveInWorkspace() used by every other write in this module, so "../../etc/cron.d/x" inside
 * the archive is refused exactly like it would be from any other endpoint here — a zip's
 * internal paths are just as untrusted as a client-supplied relPath.
 */
export function extractZipIntoWorkspace(root: string, targetRelPath: string, zipBuffer: Buffer): WorkspaceZipExtractResult {
  const targetDir = resolveInWorkspace(root, targetRelPath);

  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    throw new WorkspaceZipError(`Not a valid zip file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const entries = zip.getEntries();
  if (entries.length === 0) throw new WorkspaceZipError("The zip file is empty.");
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new WorkspaceZipError(`Refused: zip contains ${entries.length} entries, over the ${MAX_ZIP_ENTRIES}-entry limit.`);
  }

  // Validate everything before writing anything (see doc comment above for why).
  const planned: { entry: (typeof entries)[number]; destPath: string; isDir: boolean }[] = [];
  const skipped: string[] = [];
  let totalUncompressed = 0;

  for (const entry of entries) {
    const entryName = entry.entryName;

    // EXCLUDED check: does any path segment match a name the file browser already hides?
    const segments = entryName.split(/[/\\]/).filter(Boolean);
    if (segments.some((seg) => EXCLUDED.has(seg))) {
      skipped.push(entryName);
      continue;
    }

    const isDir = entry.isDirectory || entryName.endsWith("/");
    const uncompressedSize = entry.header.size;

    if (!isDir) {
      if (uncompressedSize > MAX_SINGLE_FILE_UNCOMPRESSED_BYTES) {
        throw new WorkspaceZipError(
          `Refused: "${entryName}" is ${Math.round(uncompressedSize / 1024 / 1024)}MB uncompressed, over the ${Math.round(MAX_SINGLE_FILE_UNCOMPRESSED_BYTES / 1024 / 1024)}MB per-file limit.`
        );
      }
      if (uncompressedSize > RATIO_CHECK_FLOOR_BYTES) {
        const compressedSize = entry.header.compressedSize || 1;
        const ratio = uncompressedSize / compressedSize;
        if (ratio > SUSPICIOUS_COMPRESSION_RATIO) {
          throw new WorkspaceZipError(
            `Refused: "${entryName}" compresses at ${ratio.toFixed(0)}:1, which looks like a zip bomb rather than real content.`
          );
        }
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new WorkspaceZipError(
          `Refused: extracting this zip would write over ${Math.round(MAX_TOTAL_UNCOMPRESSED_BYTES / 1024 / 1024)}MB, over the total limit.`
        );
      }
    }

    // Zip-slip protection: confine through the same helper every other write in this module
    // uses. entryName is untrusted archive content, not a client relPath, but the check is
    // identical — anything resolving outside targetDir (via "../", an absolute path baked into
    // the archive, drive-letter tricks on Windows-authored zips, etc.) is refused here.
    let destPath: string;
    try {
      destPath = resolveInWorkspace(targetDir, entryName);
    } catch {
      throw new WorkspaceZipError(`Refused: "${entryName}" in the zip resolves outside the target directory.`);
    }

    planned.push({ entry, destPath, isDir });
  }

  if (planned.length === 0) {
    throw new WorkspaceZipError("Every entry in this zip was excluded (node_modules, .git, etc.) — nothing to extract.");
  }

  // Now actually write. Directories first (by sorting shorter paths first) so a file's parent
  // always exists before the file itself, regardless of the order entries appear in the zip.
  planned.sort((a, b) => a.destPath.length - b.destPath.length);

  let filesExtracted = 0;
  let dirsCreated = 0;
  let bytesWritten = 0;

  for (const { entry, destPath, isDir } of planned) {
    if (isDir) {
      fs.mkdirSync(destPath, { recursive: true });
      dirsCreated++;
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const data = entry.getData(); // decompresses this one entry now, not at zip-open time
    fs.writeFileSync(destPath, data);
    filesExtracted++;
    bytesWritten += data.length;
  }

  return { filesExtracted, dirsCreated, bytesWritten, skipped };
}
