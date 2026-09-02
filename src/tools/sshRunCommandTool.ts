import { RemoteConfig } from "../remote/types.js";
import { connect, execCommand, execScript } from "../remote/sshConnection.js";

export interface SshRunCommandArgs {
  command: string;
  target?: string;
}

export interface SshRunCommandTargetResult {
  target: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SshRunCommandResult {
  ok: boolean;
  results: SshRunCommandTargetResult[];
}

/**
 * Executes a shell command (or multi-line bash script, detected by the presence of a newline)
 * on one or all configured remote fleet targets. This is the remote equivalent of
 * run_command_tool — the agent's remote validation step (checking a service is up, tailing
 * logs, running docker/build commands, etc.).
 */
export async function sshRunCommand(remoteConfig: RemoteConfig, args: SshRunCommandArgs): Promise<SshRunCommandResult> {
  const targets = args.target
    ? remoteConfig.targets.filter((t) => `${t.host}:${t.port}` === args.target || t.host === args.target)
    : remoteConfig.targets;

  if (targets.length === 0) {
    const known = remoteConfig.targets.map((t) => `${t.host}:${t.port}`).join(", ");
    throw new Error(`target "${args.target}" is not one of the configured targets: ${known}`);
  }

  const isScript = args.command.includes("\n");

  const results = await Promise.all(
    targets.map(async (target): Promise<SshRunCommandTargetResult> => {
      const label = `${target.host}:${target.port}`;
      try {
        const conn = await connect(target, remoteConfig.auth.user, remoteConfig.auth.password);
        const result = isScript ? await execScript(conn, args.command) : await execCommand(conn, args.command);
        conn.end();
        return { target: label, ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { target: label, ok: false, exitCode: null, stdout: "", stderr: message };
      }
    })
  );

  return { ok: results.every((r) => r.ok), results };
}

