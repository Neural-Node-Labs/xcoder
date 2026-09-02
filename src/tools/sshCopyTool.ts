import fs from "node:fs";
import path from "node:path";
import { RemoteConfig } from "../remote/types.js";
import { connect } from "../remote/sshConnection.js";
import { uploadPath } from "../remote/scpUpload.js";

export interface SshCopyArgs {
  localPath: string;
  remotePath: string;
  target?: string;
}

export interface SshCopyTargetResult {
  target: string;
  ok: boolean;
  message: string;
}

export interface SshCopyResult {
  ok: boolean;
  results: SshCopyTargetResult[];
}

/**
 * Uploads a local file or folder from the workspace to one or all configured remote fleet
 * targets over SFTP. This is how the agent gets build context, compose files, configs, etc.
 * onto the remote host(s) before running commands against them with ssh_run_command.
 */
export async function sshCopy(remoteConfig: RemoteConfig, cwd: string, args: SshCopyArgs): Promise<SshCopyResult> {
  const absLocal = path.resolve(cwd, args.localPath);
  if (!fs.existsSync(absLocal)) {
    throw new Error(`Local path "${args.localPath}" does not exist (resolved to "${absLocal}")`);
  }

  const targets = args.target
    ? remoteConfig.targets.filter((t) => `${t.host}:${t.port}` === args.target || t.host === args.target)
    : remoteConfig.targets;

  if (targets.length === 0) {
    const known = remoteConfig.targets.map((t) => `${t.host}:${t.port}`).join(", ");
    throw new Error(`target "${args.target}" is not one of the configured targets: ${known}`);
  }

  const results = await Promise.all(
    targets.map(async (target): Promise<SshCopyTargetResult> => {
      const label = `${target.host}:${target.port}`;
      try {
        const conn = await connect(target, remoteConfig.auth.user, remoteConfig.auth.password);
        const stats = await uploadPath(conn, absLocal, args.remotePath);
        conn.end();
        return {
          target: label,
          ok: true,
          message: `uploaded ${stats.filesUploaded} file(s), ${stats.dirsCreated} dir(s) to ${args.remotePath}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { target: label, ok: false, message };
      }
    })
  );

  return { ok: results.every((r) => r.ok), results };
}

