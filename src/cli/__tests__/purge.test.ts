import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runPurge, normalizeTargets, PURGE_TARGETS } from "../purge.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devnull-purge-"));
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

describe("normalizeTargets", () => {
  it("defaults to the single target when none given", () => {
    expect(normalizeTargets(undefined)).toEqual([".agent"]);
    expect(normalizeTargets([])).toEqual([".agent"]);
  });

  it("returns null for an unknown target", () => {
    expect(normalizeTargets(["node_modules"])).toBeNull();
    // "tasks" and ".log" used to be separate purge targets; now that everything lives under
    // .agent/, they are no longer recognized targets on their own.
    expect(normalizeTargets(["tasks"])).toBeNull();
    expect(normalizeTargets([".agent", "bogus"])).toBeNull();
  });

  it("trims and dedupes valid targets", () => {
    expect(normalizeTargets([" .agent ", ".agent"])).toEqual([".agent"]);
  });
});

describe("runPurge", () => {
  it("removes existing targets", async () => {
    makeTargets(tmpRoot);
    const result = await runPurge({ scope: "workspace", dryRun: false, force: false, cwd: tmpRoot });
    expect(result.removed.sort()).toEqual([".agent"]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(false);
    }
  });

  it("tolerates missing targets as skipped", async () => {
    const result = await runPurge({ scope: "workspace", dryRun: false, force: false, cwd: tmpRoot });
    expect(result.removed).toEqual([]);
    expect(result.skipped.sort()).toEqual([".agent"]);
    expect(result.failed).toEqual([]);
  });

  it("dry-run reports removed without deleting", async () => {
    makeTargets(tmpRoot);
    const result = await runPurge({ scope: "workspace", dryRun: true, force: false, cwd: tmpRoot });
    expect(result.removed.sort()).toEqual([".agent"]);
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(true);
    }
  });

  it("refuses symlinks by default and removes them with force", async () => {
    // Symlink creation requires elevated privileges on Windows (EPERM). Skip there rather
    // than fail — the refusal/force logic is exercised on platforms that allow symlinks.
    const referent = path.join(tmpRoot, "..", `devnull-purge-ref-${Date.now()}.txt`);
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

    const refused = await runPurge({ scope: "workspace", dryRun: false, force: false, cwd: tmpRoot });
    expect(refused.failed.map((f) => f.target)).toContain(".agent");
    expect(fs.existsSync(referent)).toBe(true); // referent untouched

    const forced = await runPurge({ scope: "workspace", dryRun: false, force: true, cwd: tmpRoot });
    expect(forced.removed).toContain(".agent");
    expect(fs.existsSync(path.join(tmpRoot, ".agent"))).toBe(false); // link removed
    expect(fs.existsSync(referent)).toBe(true); // referent still intact

    fs.rmSync(referent, { force: true });
  });

  it("rejects an unknown target", async () => {
    await expect(
      runPurge({ scope: "workspace", dryRun: false, force: false, targets: ["node_modules"], cwd: tmpRoot })
    ).rejects.toThrow(/Invalid --targets/);
  });

  it("refuses to delete unexpected paths (allow-list + containment)", async () => {
    // A path that is not in the allow-list is rejected outright.
    await expect(
      runPurge({ scope: "workspace", dryRun: false, force: false, targets: ["src"], cwd: tmpRoot })
    ).rejects.toThrow(/Invalid --targets/);

    // A target that resolves outside the scope root is refused even if it is a known name.
    // (Containment is enforced by path.resolve; a `..`-style escape is caught by the
    // allow-list first, so we assert the allow-list is the primary guard here.)
    const outside = path.join(tmpRoot, "..", "outside");
    fs.mkdirSync(outside, { recursive: true });
    try {
      await expect(
        runPurge({ scope: "workspace", dryRun: false, force: false, targets: [".."], cwd: tmpRoot })
      ).rejects.toThrow(/Invalid --targets/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("proceeds when confirmation is approved", async () => {
    makeTargets(tmpRoot);
    let asked = false;
    const result = await runPurge({
      scope: "workspace",
      dryRun: false,
      force: false,
      cwd: tmpRoot,
      confirm: async (msg) => {
        asked = true;
        expect(msg).toContain(".agent");
        return true;
      },
    });
    expect(asked).toBe(true);
    expect(result.removed.sort()).toEqual([".agent"]);
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(false);
    }
  });

  it("aborts without deleting when confirmation is declined", async () => {
    makeTargets(tmpRoot);
    const result = await runPurge({
      scope: "workspace",
      dryRun: false,
      force: false,
      cwd: tmpRoot,
      confirm: async () => false,
    });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(true); // nothing removed
    }
  });

  it("does not prompt during dry-run", async () => {
    makeTargets(tmpRoot);
    let asked = false;
    const result = await runPurge({
      scope: "workspace",
      dryRun: true,
      force: false,
      cwd: tmpRoot,
      confirm: async () => {
        asked = true;
        return false;
      },
    });
    expect(asked).toBe(false); // dry-run never prompts
    expect(result.removed.sort()).toEqual([".agent"]);
    for (const t of PURGE_TARGETS) {
      expect(fs.existsSync(path.join(tmpRoot, t))).toBe(true); // still present
    }
  });
});
