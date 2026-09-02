import { parseTargets } from "./sshConnection.js";
import { RemoteConfig } from "./types.js";

/**
 * Nilo-load ang paunang-nakaconfigure na remote deployment fleet mula sa mga environment
 * variable:
 *   DEVNULL_SSH_TARGETS  - comma-separated na "host" o "host:port" na listahan, hal.
 *                         "10.0.0.5,10.0.0.6:2222"
 *   DEVNULL_SSH_USER     - ibinabahaging SSH username para sa lahat ng target
 *   DEVNULL_SSH_PASSWORD - ibinabahaging SSH password para sa lahat ng target
 *
 * Nagbabalik ng null kung hindi naka-set ang DEVNULL_SSH_TARGETS, para makapagbigay ang
 * ssh_copy_tool/ssh_run_command ng malinaw na "not configured" na error sa halip na
 * makaranas ang agent ng nakakalitong crash.
 */
export function loadRemoteConfig(): RemoteConfig | null {
  const targetsRaw = process.env.DEVNULL_SSH_TARGETS;
  if (!targetsRaw) return null;

  const targets = parseTargets(targetsRaw);
  if (targets.length === 0) return null;

  const user = process.env.DEVNULL_SSH_USER ?? "";
  const password = process.env.DEVNULL_SSH_PASSWORD ?? "";

  return { targets, auth: { user, password } };
}

