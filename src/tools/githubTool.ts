import { spawn } from "node:child_process";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.on("error", (err) => resolve({ exitCode: -1, stdout, stderr: String(err) }));
  });
}

/**
 * Auth header args for git operating over HTTPS with a GitHub token, without ever writing
 * the token to disk (no credential helper, no token embedded in the remote URL config).
 */
function authArgs(): string[] {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];
  const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${b64}`];
}

export async function githubClone(repoUrl: string, targetDir: string, branch?: string): Promise<GitResult> {
  const args = [...authArgs(), "clone", ...(branch ? ["-b", branch] : []), repoUrl, targetDir];
  return run("git", args);
}

export async function githubFetch(repoDir: string, remote = "origin"): Promise<GitResult> {
  return run("git", [...authArgs(), "fetch", remote], repoDir);
}

export async function githubPull(repoDir: string, remote = "origin", branch?: string): Promise<GitResult> {
  const args = [...authArgs(), "pull", remote, ...(branch ? [branch] : [])];
  return run("git", args, repoDir);
}

export async function githubStatus(repoDir: string): Promise<GitResult> {
  return run("git", ["status", "--short", "--branch"], repoDir);
}

export async function githubCommit(repoDir: string, message: string, files: string[] = ["."]): Promise<GitResult> {
  const add = await run("git", ["add", ...files], repoDir);
  if (add.exitCode !== 0) return add;
  return run("git", ["commit", "-m", message], repoDir);
}

export async function githubPush(repoDir: string, remote = "origin", branch?: string): Promise<GitResult> {
  const args = [...authArgs(), "push", remote, ...(branch ? [branch] : [])];
  return run("git", args, repoDir);
}


