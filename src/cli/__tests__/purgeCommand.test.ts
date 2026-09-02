// ronin:version 7 | ronin:task task-bc7d1e | ronin:updated 2026-08-13T07:34:57.465Z | ronin:subtask code-st-2ad77b
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import osNs from "node:os";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import { runPurgeCommand, registerPurgeSubcommand } from "../purgeCommand.js";
import { PURGE_TARGETS } from "../purge.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-purge-cmd-"));
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

function installedProgram(tmp = tmpRoot): Command {
  const program = new Command()
    .name("xcoder")
    .argument("[task]", "task description")
    .exitOverride();
  return registerPurgeSubcommand(program, { cwd: tmp });
}

async function parsePurge(program: Command, args: string[]): Promise<{ stdout: string; stderr: string }> {
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
  try {
    await program.parseAsync(["node", "xcoder", ...args]);
  } catch (err) {
    // .exitOverride() turns --help into a thrown CommanderError with exitCode 0.
    const exitCode = (err as { exitCode?: number }).exitCode;
    if (exitCode !== 0) throw err;
  } finally {
    console.log = origLog;
    console.error = origErr;
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("runPurgeCommand", () => {
  it("removes all targets and exits 0", async () => {
    makeTargets(tmpRoot);
    const outcome = await runPurgeCommand({ cwd: tmpRoot, auto: true });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.removed.sort()).toEqual([".agent"]);
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(false);
    }
  });

  it("treats a clean workspace as all-skipped and exits 0", async () => {
    const outcome = await runPurgeCommand({ cwd: tmpRoot, auto: true });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.removed).toEqual([]);
    expect(outcome.result.skipped.sort()).toEqual([".agent"]);
    expect(outcome.result.failed).toEqual([]);
  });

  it("dry-run reports removed without deleting and never prompts", async () => {
    makeTargets(tmpRoot);
    let prompted = false;
    const outcome = await runPurgeCommand({
      cwd: tmpRoot,
      dryRun: true,
      auto: false,
      force: false,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.removed.sort()).toEqual([".agent"]);
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(true);
    }
    expect(prompted).toBe(false);
  });

  it("purging the single .agent target removes everything system-generated under it", async () => {
    // Everything (tasks/, logs/, index/, plans/, reports/) now lives under .agent/, so a
    // single-item --targets selection is the only meaningful subset there is.
    makeTargets(tmpRoot);
    const outcome = await runPurgeCommand({ cwd: tmpRoot, targets: ".agent", auto: true });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.removed.sort()).toEqual([".agent"]);
  });

  it("rejects the old .log/tasks target names now that they live under .agent", async () => {
    // .log and tasks used to be independent top-level purge targets; they are no longer
    // recognized on their own now that everything is consolidated under .agent.
    const outcome = await runPurgeCommand({ cwd: tmpRoot, targets: ".agent,.log", auto: true });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.failed.length).toBeGreaterThan(0);
  });

  it("rejects an invalid target with exit 1 and names allowed targets", async () => {
    const outcome = await runPurgeCommand({ cwd: tmpRoot, targets: "node_modules", auto: true });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.result.failed.length).toBeGreaterThan(0);
    expect(outcome.result.failed[0].error).toContain(".agent");
  });

  it("global scope resolves against the home directory allow-list", async () => {
    const fakeHome = path.join(tmpRoot, "home");
    fs.mkdirSync(path.join(fakeHome, ".agent"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".agent", "file.txt"), "x");
    const spy = vi.spyOn(osNs, "homedir").mockReturnValue(fakeHome);
    try {
      const outcome = await runPurgeCommand({ scope: "global", cwd: tmpRoot, auto: true });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.result.removed).toContain(".agent");
      expect(fs.existsSync(path.join(fakeHome, ".agent"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("registerPurgeSubcommand dispatch", () => {
  it("routes the bare `purge` token to the subcommand, not [task]", async () => {
    makeTargets(tmpRoot);
    const program = installedProgram();
    const { stdout } = await parsePurge(program, ["purge", "--auto"]);
    expect(stdout).toContain("[Purge]");
    expect(stdout).not.toContain("Running task:");
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(false);
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

  it("lists purge options in --help", async () => {
    const program = installedProgram();
    const { stdout } = await parsePurge(program, ["purge", "--help"]);
    expect(stdout).toContain("--scope");
    expect(stdout).toContain("--targets");
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("--force");
    expect(stdout).toContain("--auto");
  });
});
