import { spawn } from "node:child_process";

export interface PlaywrightRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  summary?: { passed: number; failed: number; skipped: number };
}

/**
 * Runs a Playwright test file (or all tests if scriptPath is omitted) via `npx playwright test`.
 * Assumes the target workspace already has @playwright/test configured (playwright.config.ts,
 * browsers installed via `npx playwright install`) — xcoder does not bundle Playwright itself,
 * since UI tests belong to the project under test, not to the agent.
 */
export function runPlaywrightTest(
  scriptPath: string | undefined,
  cwd: string = process.cwd(),
  extraArgs: string[] = []
): Promise<PlaywrightRunResult> {
  return new Promise((resolve) => {
    const args = ["playwright", "test", ...(scriptPath ? [scriptPath] : []), "--reporter=json", ...extraArgs];
    const child = spawn("npx", args, { cwd, timeout: 300_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      const summary = parseSummary(stdout);
      resolve({ exitCode: code ?? -1, stdout, stderr, summary });
    });
    child.on("error", (err) => resolve({ exitCode: -1, stdout, stderr: String(err) }));
  });
}

function parseSummary(jsonOutput: string): PlaywrightRunResult["summary"] | undefined {
  try {
    const parsed = JSON.parse(jsonOutput);
    const stats = parsed.stats ?? {};
    return {
      passed: stats.expected ?? 0,
      failed: stats.unexpected ?? 0,
      skipped: stats.skipped ?? 0,
    };
  } catch {
    return undefined; // non-JSON output (e.g. playwright not installed) — caller sees raw stdout/stderr
  }
}


