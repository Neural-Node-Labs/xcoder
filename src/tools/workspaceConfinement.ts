import path from "node:path";

/**
 * Opt-in path confinement for read_tool/write_edit_tool.
 *
 * By default xcoder's file tools resolve any path handed to them — absolute paths are used
 * as-is, relative paths are joined against `cwd` with no check that the result stays inside
 * `cwd` (e.g. `../../etc/passwd` resolves right on out). Since `run_command_tool` already
 * grants unrestricted shell access by design, this isn't a new *capability* for a fully-trusted
 * agent — but it does mean there's no cheap way to sandbox a task to "only touch files under
 * this project" as a safety rail against, say, a prompt-injected instruction from a crawled
 * page or a malicious file in the repo convincing the model to write outside the workspace.
 *
 * Set XCODER_RESTRICT_TO_WORKSPACE=true to opt into confinement: any resolved path that would
 * land outside `cwd` is rejected before the filesystem is touched. Off by default so existing
 * workflows that intentionally read/write outside the project (global configs, temp dirs, etc.)
 * keep working unchanged.
 */
export function isWorkspaceConfinementEnabled(): boolean {
  return process.env.XCODER_RESTRICT_TO_WORKSPACE === "true";
}

export class WorkspaceEscapeError extends Error {
  constructor(filePath: string, cwd: string) {
    super(
      `Refused: "${filePath}" resolves outside the workspace root "${cwd}". ` +
        `Set XCODER_RESTRICT_TO_WORKSPACE=false (or unset it) to allow paths outside the workspace.`
    );
    this.name = "WorkspaceEscapeError";
  }
}

/**
 * Resolves `filePath` against `cwd` the same way the tools already do (absolute paths used
 * as-is, relative paths joined to cwd), and — only if confinement is enabled — throws if the
 * result escapes `cwd`. Returns the resolved absolute path either way.
 */
export function resolveConfinedPath(filePath: string, cwd: string): string {
  const full = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

  if (!isWorkspaceConfinementEnabled()) return full;

  const resolvedCwd = path.resolve(cwd);
  const resolvedFull = path.resolve(full);
  const relative = path.relative(resolvedCwd, resolvedFull);

  const escapes = relative.startsWith("..") || path.isAbsolute(relative);
  if (escapes) throw new WorkspaceEscapeError(filePath, resolvedCwd);

  return resolvedFull;
}
