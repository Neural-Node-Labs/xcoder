import { spawn } from "node:child_process";
import * as fs from "node:fs";

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ─── Platform-aware shell resolution ────────────────────────────────────────
//
// Previously this always used `spawn(command, { shell: true })`, which resolves to cmd.exe on
// Windows and /bin/sh on POSIX. Two problems with that default:
//
// 1. On Windows, cmd.exe has no equivalent at all for the Unix commands DeepSeek generates by
//    default (ls, cat, rm -rf, grep, which, export FOO=bar, ...) — these fail outright with
//    "not recognized as an internal or external command". PowerShell ships built-in aliases for
//    many of them (ls -> Get-ChildItem, cat -> Get-Content, rm -> Remove-Item, cp -> Copy-Item,
//    pwd -> Get-Location, ...), which meaningfully closes the gap without requiring WSL.
//
// 2. On many Linux distros (Debian/Ubuntu and derivatives), /bin/sh is dash, not bash — dash
//    rejects bash-only syntax (`[[ ]]`, arrays, process substitution, `source`) that a
//    bash-trained model commonly produces. Preferring an actual bash binary avoids that class
//    of failure.
//
// NOTE: we do NOT use spawn's `shell: "powershell.exe"` string shortcut. Node's automatic
// shell-wrapping passes `-c <command>` to any non-cmd.exe shell string, but `-c` is an
// *ambiguous* abbreviation for powershell.exe (it partially matches both -Command and
// -ConfigurationName), which PowerShell rejects outright. Spawning powershell.exe directly with
// an explicit -Command argument avoids that.

type ShellPlan =
  | { kind: "powershell" }
  | { kind: "bash"; path: string }
  | { kind: "default" }; // fall back to Node's spawn(..., { shell: true }) default

let cachedPlan: ShellPlan | undefined;

function resolveShellPlan(): ShellPlan {
  if (cachedPlan) return cachedPlan;

  if (process.platform === "win32") {
    cachedPlan = { kind: "powershell" };
    return cachedPlan;
  }

  const bashCandidates = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"];
  const bashPath = bashCandidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  cachedPlan = bashPath ? { kind: "bash", path: bashPath } : { kind: "default" };
  return cachedPlan;
}

/** Human-readable description of the shell commands will run through, for the system prompt —
 *  so the model can adapt its command syntax instead of assuming bash everywhere. */
export function describeShell(): string {
  const plan = resolveShellPlan();
  if (plan.kind === "powershell") {
    return (
      "Windows PowerShell. Use PowerShell cmdlets/aliases (Get-ChildItem/ls, Get-Content/cat, " +
      "Remove-Item/rm, Copy-Item/cp, Get-Location/pwd, Set-Content, Test-Path) rather than bash " +
      "syntax. `&&`/`||` chaining only works on PowerShell 7+; use `;` or separate calls to be " +
      "safe. Set environment variables with `$env:NAME = \"value\"`, not `export NAME=value`."
    );
  }
  if (plan.kind === "bash") {
    return `bash (${plan.path}). Standard bash/POSIX syntax is safe.`;
  }
  return "the platform's default shell (bash not found — avoid bash-only syntax such as [[ ]], arrays, or process substitution, as the default /bin/sh may be dash).";
}

/**
 * Executes the Validation phase's Action: run tests / linter / type-checker / kubectl /
 * docker build / repro steps — whatever the active skill needs — and returns the raw
 * Observation for the ReAct loop to reason over.
 */
export function runCommand(command: string, cwd: string = process.cwd(), timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Strip NODE_ENV so it doesn't leak from xcoder's own container runtime
    // config (set to "production" in the Dockerfile/docker-compose.yml) into
    // build/install commands run against the target workspace. Left as-is,
    // `npm install`/`npm ci` in child commands would silently skip
    // devDependencies for any project xcoder is asked to work on.
    const { NODE_ENV, ...childEnv } = process.env;

    const plan = resolveShellPlan();
    const child =
      plan.kind === "powershell"
        ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
            cwd,
            timeout: timeoutMs,
            env: childEnv,
          })
        : plan.kind === "bash"
        ? spawn(plan.path, ["-c", command], { cwd, timeout: timeoutMs, env: childEnv })
        : spawn(command, { cwd, shell: true, timeout: timeoutMs, env: childEnv });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      resolve({ command, exitCode: code ?? -1, stdout, stderr });
    });

    child.on("error", (err) => {
      // e.g. powershell.exe/bash binary not actually found despite the check above
      resolve({ command, exitCode: -1, stdout, stderr: stderr + String(err) });
    });
  });
}


