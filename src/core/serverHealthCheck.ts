import { spawn, execFile, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";

const execFileP = promisify(execFile);

export interface HealthCheckResult {
  responded: boolean;
  statusCode?: number;
  body?: string;
  detail: string;
}

/**
 * Spawns `node <entryFile>` (or a custom start command) in `dir` with PORT set, polls
 * `http://localhost:<port><healthPath>` for real until it responds or the timeout elapses,
 * and always kills the process afterward regardless of outcome. This is a genuine functional
 * check -- it proves the server actually starts and actually serves a real HTTP response,
 * not just that files with plausible-looking content exist on disk.
 */
export async function startServerAndCheckHealth(
  dir: string,
  startCommand: string,
  port: number,
  healthPath: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<HealthCheckResult> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 300;
  const isWindows = process.platform === "win32";

  let child: ChildProcess | undefined;
  try {
    child = spawn(startCommand, {
      cwd: dir,
      shell: true,
      env: { ...process.env, PORT: String(port) },
      // On POSIX this puts the child in its own process group so we can kill the whole tree
      // (shell + whatever it spawned) via a negative-pid kill below. `detached` has no such
      // effect on Windows -- process groups there are handled entirely differently, so the
      // finally block below branches on platform instead of relying on this.
      detached: !isWindows,
    });

    let earlyExit: string | undefined;
    child.on("exit", (code, signal) => {
      if (earlyExit === undefined) earlyExit = `process exited early (code=${code}, signal=${signal})`;
    });
    let stderrBuf = "";
    child.stderr?.on("data", (d) => (stderrBuf += d.toString()));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (earlyExit) {
        return { responded: false, detail: `${earlyExit}. stderr: ${stderrBuf.slice(0, 500)}` };
      }
      const result = await tryGet(port, healthPath);
      if (result) {
        return { responded: true, statusCode: result.statusCode, body: result.body, detail: `responded with status ${result.statusCode}` };
      }
      await sleep(pollIntervalMs);
    }
    return { responded: false, detail: `timed out after ${timeoutMs}ms waiting for a response on port ${port}${healthPath}. stderr: ${stderrBuf.slice(0, 500)}` };
  } finally {
    if (child?.pid && !child.killed) {
      if (isWindows) {
        // shell:true on Windows means child.pid is cmd.exe's PID, not the real process
        // startCommand launched (e.g. `node app.js` runs as a grandchild). `detached` +
        // negative-pid kill is a POSIX process-group convention that doesn't apply here, so a
        // plain child.kill() would only kill cmd.exe and leave the actual server orphaned and
        // still bound to the port. `taskkill /T` kills the whole process tree instead.
        try {
          await execFileP("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
        } catch {
          // Tree may already be gone -- fall back to a direct kill attempt.
          try {
            child.kill();
          } catch {
            /* already dead */
          }
        }
      } else {
        try {
          // Negative pid = kill the whole process group (shell + whatever it spawned), not just the shell.
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Group may already be gone (process exited on its own) -- fall back to a direct kill attempt.
          try {
            child.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
      }
    }
  }
}

function tryGet(port: number, path: string): Promise<{ statusCode: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: "localhost", port, path, timeout: 1000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


