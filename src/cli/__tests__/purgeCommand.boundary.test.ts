// ronin:version 2 | ronin:task task-bc7d1e | ronin:updated 2026-08-13T07:40:21.179Z | ronin:subtask test-st-d892f8
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import { runPurgeCommand, registerPurgeSubcommand } from "../purgeCommand.js";
import { PURGE_TARGETS } from "../purge.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-purge-boundary-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeTargets(root: string): void {
  for (const t of PURGE_TARGETS) {
    fs.mkdirSync(path.join(root, t), { recursive: true });
    fs.writeFileSync(path.join(root, t, "file.txt"), "x");
  }
}

/**
 * Mirrors src/cli/index.ts wiring order: the purge subcommand is registered BEFORE
 * the parent `[task]` positional is declared.
 */
function installedProgram(tmp = tmpRoot): Command {
  const program = new Command()
    .name("xcoder")
    .description("xcoder")
    .version("0.1.0")
    .showHelpAfterError()
    .exitOverride();
  registerPurgeSubcommand(program, { cwd: tmp });
  return program.argument("[task]", "task description");
}

interface ParseOutcome {
  stdout: string;
  stderr: string;
  error?: { exitCode?: number; code?: string };
}

async function parsePurge(program: Command, args: string[]): Promise<ParseOutcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk).replace(/\n$/, ""));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk).replace(/\n$/, ""));
    return true;
  });
  console.log = (...a: unknown[]) => stdout.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => stderr.push(a.map(String).join(" "));
  let error: { exitCode?: number; code?: string } | undefined;
  try {
    await program.parseAsync(["node", "xcoder", ...args]);
  } catch (err) {
    const e = err as { exitCode?: number; code?: string };
    // .exitOverride() turns --help into a thrown CommanderError with exitCode 0.
    if (e.exitCode !== 0) error = e;
  } finally {
    console.log = origLog;
    console.error = origErr;
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), error };
}

// Non-TTY runs must auto-approve by design (see runPurgeCommand doc comment).
// Skip these on a developer TTY so they can never hang waiting on stdin.
const nonTty = process.stdin.isTTY ? it.skip : it;

describe("runPurgeCommand boundary cases", () => {
  it("normalizes whitespace-padded --targets entries", async () => {
    makeTargets(tmpRoot);
    const outcome = await runPurgeCommand({ cwd: tmpRoot, targets: "  .agent  ", auto: true });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.removed.sort()).toEqual([".agent"]);
    expect(fs.existsSync(path.join(tmpRoot, ".agent"))).toBe(false);
  });

  nonTty("auto-approves and deletes when run non-interactively without --auto", async () => {
    makeTargets(tmpRoot);
    const outcome = await runPurgeCommand({ cwd: tmpRoot });
    expect(outcome.exitCode).toBe(0);
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(false);
    }
  });

  it("dry-run still refuses a symlink and exits 1 without touching anything", async () => {
    // Symlink creation requires elevated privileges on Windows (EPERM); skip there.
    const referent = path.join(tmpRoot, "..", `xcoder-purge-ref-${Date.now()}.txt`);
    fs.writeFileSync(referent, "keep");
    try {
      fs.symlinkSync(referent, path.join(tmpRoot, ".agent"), "file");
    } catch (err) {
      if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") {
        fs.rmSync(referent, { force: true });
        return; // skip: symlink creation not permitted in this environment
      }
      throw err;
    }
    const outcome = await runPurgeCommand({ cwd: tmpRoot, dryRun: true, auto: true });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.dryRun).toBe(true);
    expect(outcome.result.failed.map((f) => f.target)).toContain(".agent");
    expect(outcome.result.removed).not.toContain(".agent");
    expect(fs.existsSync(path.join(tmpRoot, ".agent"))).toBe(true);
    expect(fs.existsSync(referent)).toBe(true);
    fs.rmSync(referent, { force: true });
  });
});

describe("purge subcommand dispatch (index.ts registration order)", () => {
  it("routes the bare `purge` token to the subcommand, not the [task] positional", async () => {
    makeTargets(tmpRoot);
    const program = installedProgram();
    let parentActionRan = false;
    program.action(() => {
      parentActionRan = true;
    });
    const { stdout } = await parsePurge(program, ["purge", "--auto"]);
    expect(parentActionRan).toBe(false);
    expect(stdout).toContain("[Purge]");
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(false);
    }
  });

  nonTty("bare `purge` (no --auto) auto-approves in non-TTY and deletes", async () => {
    makeTargets(tmpRoot);
    const program = installedProgram();
    const { stdout } = await parsePurge(program, ["purge"]);
    expect(stdout).toContain("[Purge]");
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(false);
    }
  });

  it("purge --targets .agent leaves unrelated workspace files untouched", async () => {
    // .agent is now the only recognized purge target (tasks/logs/index/plans/reports all
    // live inside it), so this verifies the purge is contained to .agent and doesn't touch
    // an unrelated file sitting alongside it in the workspace.
    makeTargets(tmpRoot);
    fs.writeFileSync(path.join(tmpRoot, "README.md"), "keep me");
    const program = installedProgram();
    await parsePurge(program, ["purge", "--targets", ".agent", "--auto"]);
    expect(fs.existsSync(path.join(tmpRoot, ".agent"))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, "README.md"))).toBe(true);
  });

  it("purge --dry-run prints the dry-run label and deletes nothing", async () => {
    makeTargets(tmpRoot);
    const program = installedProgram();
    const { stdout } = await parsePurge(program, ["purge", "--dry-run"]);
    expect(stdout).toContain("(dry-run)");
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(true);
    }
  });

  it("keeps multi-word quoted tasks on the parent [task] path", async () => {
    const program = installedProgram();
    let ranTask = "";
    program.action(async (taskArg: string) => {
      ranTask = taskArg;
    });
    await parsePurge(program, ["purge my sticky notes"]);
    expect(ranTask).toBe("purge my sticky notes");
  });

  it("rejects an invalid --targets value from the CLI with exit code 1 and names allowed targets", async () => {
    const program = installedProgram();
    const prevExitCode = process.exitCode;
    try {
      const { stderr } = await parsePurge(program, ["purge", "--targets", "node_modules"]);
      expect(stderr).toContain(".agent");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it("shows purge help after an unknown option error (showHelpAfterError)", async () => {
    const program = installedProgram();
    const { stderr, error } = await parsePurge(program, ["purge", "--bogus"]);
    expect(error?.exitCode).toBe(1);
    expect(stderr.toLowerCase()).toContain("unknown option");
    expect(stderr).toContain("--targets");
    expect(stderr).toContain("Usage: xcoder purge");
  });
});
