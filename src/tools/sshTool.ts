import { spawn } from "node:child_process";
import { Client, SFTPWrapper } from "ssh2";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { verifyHostKeyTofu } from "../remote/hostKeyStore.js";

export interface SshTarget {
  host: string;
  user: string;
  port?: number;
  keyPath?: string;
  password?: string;
}

export interface SshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ─── ssh2-based helpers (for password auth, cross-platform) ─────────────────

/**
 * Execute a command via ssh2 Client (password auth). Returns SshResult.
 */
function ssh2Exec(target: SshTarget, command: string, timeoutMs = 60_000): Promise<SshResult> {
  return new Promise((resolve) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (exitCode: number) => {
      if (done) return;
      done = true;
      conn.end();
      resolve({ exitCode, stdout, stderr });
    };

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          finish(-1);
          stderr = String(err);
          return;
        }
        stream.on("data", (d: Buffer) => { stdout += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        stream.on("close", (code: number | null) => {
          finish(code ?? -1);
        });
      });
    });

    conn.on("error", (err) => {
      finish(-1);
      stderr = String(err);
    });

    conn.connect({
      host: target.host,
      port: target.port ?? 22,
      username: target.user,
      password: target.password,
      readyTimeout: 10000,
      // Trust-on-first-use: record the fingerprint on first connect, require a match on
      // every connect after that. See src/remote/hostKeyStore.ts for details/rationale.
      hostHash: "sha256",
      hostVerifier: (fingerprintHex: string) => {
        const result = verifyHostKeyTofu(target.host, target.port ?? 22, fingerprintHex);
        if (!result.accepted) stderr += result.reason;
        return result.accepted;
      },
    });

    // Timeout
    setTimeout(() => {
      if (!done) finish(-1);
    }, timeoutMs);
  });
}

/**
 * Upload a file via ssh2 SFTP (password auth).
 */
function ssh2Upload(target: SshTarget, localPath: string, remotePath: string, recursive = false): Promise<SshResult> {
  return new Promise((resolve) => {
    const conn = new Client();
    let stderr = "";
    let done = false;

    const finish = (exitCode: number, out: string) => {
      if (done) return;
      done = true;
      conn.end();
      resolve({ exitCode, stdout: out, stderr });
    };

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) {
          finish(-1, "");
          stderr = String(err);
          return;
        }
        doUpload(sftp, localPath, remotePath, recursive, finish, stderr);
      });
    });

    conn.on("error", (err) => {
      finish(-1, "");
      stderr = String(err);
    });

    conn.connect({
      host: target.host,
      port: target.port ?? 22,
      username: target.user,
      password: target.password,
      readyTimeout: 10000,
      // Trust-on-first-use: record the fingerprint on first connect, require a match on
      // every connect after that. See src/remote/hostKeyStore.ts for details/rationale.
      hostHash: "sha256",
      hostVerifier: (fingerprintHex: string) => {
        const result = verifyHostKeyTofu(target.host, target.port ?? 22, fingerprintHex);
        if (!result.accepted) stderr += result.reason;
        return result.accepted;
      },
    });
  });
}

function doUpload(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  recursive: boolean,
  finish: (code: number, out: string) => void,
  stderr: string,
) {
  const localStat = fs.statSync(localPath);
  if (localStat.isDirectory()) {
    if (!recursive) {
      finish(-1, "");
      stderr = "Cannot upload directory without recursive flag";
      return;
    }
    // Create remote dir, then upload contents
    sftp.mkdir(remotePath, { mode: 0o755 }, (err) => {
      // Ignore error if dir already exists
      const items = fs.readdirSync(localPath);
      let pending = items.length;
      if (pending === 0) {
        finish(0, `Uploaded directory ${localPath} -> ${remotePath}`);
        return;
      }
      for (const item of items) {
        const localItem = path.join(localPath, item);
        const remoteItem = path.join(remotePath, item).replace(/\\/g, "/");
        const itemStat = fs.statSync(localItem);
        if (itemStat.isDirectory()) {
          doUpload(sftp, localItem, remoteItem, true, (code, out) => {
            pending--;
            if (pending <= 0) finish(code, out);
          }, stderr);
        } else {
          sftp.fastPut(localItem, remoteItem, (err2) => {
            pending--;
            if (err2) { stderr += String(err2); }
            if (pending <= 0) finish(0, `Uploaded ${localPath} -> ${remotePath}`);
          });
        }
      }
    });
  } else {
    sftp.fastPut(localPath, remotePath, (err2) => {
      if (err2) {
        finish(-1, "");
        stderr = String(err2);
      } else {
        finish(0, `Uploaded ${localPath} -> ${remotePath}`);
      }
    });
  }
}

/**
 * Download a file via ssh2 SFTP (password auth).
 */
function ssh2Download(target: SshTarget, remotePath: string, localPath: string, recursive = false): Promise<SshResult> {
  return new Promise((resolve) => {
    const conn = new Client();
    let stderr = "";
    let done = false;

    const finish = (exitCode: number, out: string) => {
      if (done) return;
      done = true;
      conn.end();
      resolve({ exitCode, stdout: out, stderr });
    };

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) {
          finish(-1, "");
          stderr = String(err);
          return;
        }
        doDownload(sftp, remotePath, localPath, recursive, finish, stderr);
      });
    });

    conn.on("error", (err) => {
      finish(-1, "");
      stderr = String(err);
    });

    conn.connect({
      host: target.host,
      port: target.port ?? 22,
      username: target.user,
      password: target.password,
      readyTimeout: 10000,
      // Trust-on-first-use: record the fingerprint on first connect, require a match on
      // every connect after that. See src/remote/hostKeyStore.ts for details/rationale.
      hostHash: "sha256",
      hostVerifier: (fingerprintHex: string) => {
        const result = verifyHostKeyTofu(target.host, target.port ?? 22, fingerprintHex);
        if (!result.accepted) stderr += result.reason;
        return result.accepted;
      },
    });
  });
}

function doDownload(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  recursive: boolean,
  finish: (code: number, out: string) => void,
  stderr: string,
) {
  sftp.stat(remotePath, (err, stats) => {
    if (err) {
      finish(-1, "");
      stderr = String(err);
      return;
    }
    if (stats.isDirectory()) {
      if (!recursive) {
        finish(-1, "");
        stderr = "Cannot download directory without recursive flag";
        return;
      }
      fs.mkdirSync(localPath, { recursive: true });
      sftp.readdir(remotePath, (err2, items) => {
        if (err2) {
          finish(-1, "");
          stderr = String(err2);
          return;
        }
        let pending = items.length;
        if (pending === 0) {
          finish(0, `Downloaded directory ${remotePath} -> ${localPath}`);
          return;
        }
        for (const item of items) {
          const remoteItem = path.posix.join(remotePath, item.filename);
          const localItem = path.join(localPath, item.filename);
          doDownload(sftp, remoteItem, localItem, true, (code, out) => {
            pending--;
            if (pending <= 0) finish(code, out);
          }, stderr);
        }
      });
    } else {
      sftp.fastGet(remotePath, localPath, (err2) => {
        if (err2) {
          finish(-1, "");
          stderr = String(err2);
        } else {
          finish(0, `Downloaded ${remotePath} -> ${localPath}`);
        }
      });
    }
  });
}

// ─── Shell-out helpers (for key-based auth, works everywhere) ───────────────

/**
 * Build the base SSH args array.
 * When a password is provided, we omit BatchMode=yes (which disables password auth)
 * and use sshpass to pass the password non-interactively.
 */
function sshBaseArgs(target: SshTarget, extra: string[] = []): string[] {
  const args = ["-o", "StrictHostKeyChecking=accept-new"];
  if (!target.password) args.push("-o", "BatchMode=yes");
  if (target.port) args.push("-p", String(target.port));
  if (target.keyPath) args.push("-i", target.keyPath);
  return [...args, ...extra];
}

/**
 * Build the full command + args array, optionally wrapping with sshpass when a
 * password is set. This keeps the password out of the process argv (sshpass reads
 * it from the SSHPASS env var) so it won't appear in logs or /proc.
 */
function buildSshCommand(cmd: string, args: string[], target: SshTarget): { cmd: string; args: string[] } {
  if (target.password) {
    return {
      cmd: "sshpass",
      args: ["-e", cmd, ...args],
    };
  }
  return { cmd, args };
}

function run(cmd: string, args: string[], target?: SshTarget, timeoutMs = 60_000): Promise<SshResult> {
  return new Promise((resolve) => {
    const { cmd: resolvedCmd, args: resolvedArgs } = target ? buildSshCommand(cmd, args, target) : { cmd, args };
    const child = spawn(resolvedCmd, resolvedArgs, {
      timeout: timeoutMs,
      env: target?.password ? { ...process.env, SSHPASS: target.password } : process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
    child.on("error", (err) => resolve({ exitCode: -1, stdout, stderr: String(err) }));
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Runs a single command on the remote host over SSH.
 * Uses ssh2 (Node.js native) for password auth, shell-out for key-based auth.
 */
export async function sshExec(target: SshTarget, command: string): Promise<SshResult> {
  // If password is provided, use ssh2 (cross-platform, no sshpass needed)
  if (target.password) {
    return ssh2Exec(target, command);
  }
  // Otherwise use shell-out (key-based auth)
  const args = [...sshBaseArgs(target), `${target.user}@${target.host}`, command];
  return run("ssh", args, target);
}

/**
 * Uploads a local file/dir to the remote host via scp (key-based) or SFTP (password).
 */
export async function scpUpload(target: SshTarget, localPath: string, remotePath: string, recursive = false): Promise<SshResult> {
  // If password is provided, use ssh2 SFTP (cross-platform)
  if (target.password) {
    return ssh2Upload(target, localPath, remotePath, recursive);
  }
  // Otherwise use shell-out scp (key-based auth)
  const scpArgs = ["-o", "StrictHostKeyChecking=accept-new"];
  if (!target.password) scpArgs.push("-o", "BatchMode=yes");
  if (target.port) scpArgs.push("-P", String(target.port));
  if (target.keyPath) scpArgs.push("-i", target.keyPath);
  if (recursive) scpArgs.push("-r");
  scpArgs.push(localPath, `${target.user}@${target.host}:${remotePath}`);
  return run("scp", scpArgs, target, 300_000);
}

/**
 * Downloads a remote file/dir to a local path via scp (key-based) or SFTP (password).
 */
export async function scpDownload(target: SshTarget, remotePath: string, localPath: string, recursive = false): Promise<SshResult> {
  // If password is provided, use ssh2 SFTP (cross-platform)
  if (target.password) {
    return ssh2Download(target, remotePath, localPath, recursive);
  }
  // Otherwise use shell-out scp (key-based auth)
  const scpArgs = ["-o", "StrictHostKeyChecking=accept-new"];
  if (!target.password) scpArgs.push("-o", "BatchMode=yes");
  if (target.port) scpArgs.push("-P", String(target.port));
  if (target.keyPath) scpArgs.push("-i", target.keyPath);
  if (recursive) scpArgs.push("-r");
  scpArgs.push(`${target.user}@${target.host}:${remotePath}`, localPath);
  return run("scp", scpArgs, target, 300_000);
}

