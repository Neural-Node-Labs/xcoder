/**
 * Regression suite for playwrightTool.ts. `npx playwright test` isn't available in this
 * environment (and shelling out to npx would either attempt a real network install or hang on
 * an interactive prompt), so node:child_process is mocked here — this still exercises the
 * real argument construction, stdout/stderr capture, and JSON-reporter summary parsing logic,
 * which is where the actual bugs would live.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

async function loadWithSpawn(spawnImpl: (cmd: string, args: string[], opts: any) => any) {
  vi.resetModules();
  const spawnMock = vi.fn(spawnImpl);
  vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
  const { runPlaywrightTest } = await import("../playwrightTool.js");
  return { runPlaywrightTest, spawnMock };
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

describe("runPlaywrightTest — argument construction", () => {
  it("runs 'npx playwright test <scriptPath> --reporter=json' when a scriptPath is given", async () => {
    const { runPlaywrightTest, spawnMock } = await loadWithSpawn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await runPlaywrightTest("e2e/login.spec.ts", "/workspace");

    expect(spawnMock).toHaveBeenCalledWith(
      "npx",
      ["playwright", "test", "e2e/login.spec.ts", "--reporter=json"],
      expect.objectContaining({ cwd: "/workspace", timeout: 300_000 })
    );
  });

  it("omits the scriptPath argument entirely when not provided (runs the whole suite)", async () => {
    const { runPlaywrightTest, spawnMock } = await loadWithSpawn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await runPlaywrightTest(undefined, "/workspace");

    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(args).toEqual(["playwright", "test", "--reporter=json"]);
  });

  it("appends any extraArgs after --reporter=json", async () => {
    const { runPlaywrightTest, spawnMock } = await loadWithSpawn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await runPlaywrightTest("e2e/x.spec.ts", "/workspace", ["--headed", "--workers=1"]);

    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(args).toEqual(["playwright", "test", "e2e/x.spec.ts", "--reporter=json", "--headed", "--workers=1"]);
  });
});

describe("runPlaywrightTest — stdout/stderr capture and exit code", () => {
  it("accumulates chunked stdout/stderr and reports the real exit code", async () => {
    const { runPlaywrightTest } = await loadWithSpawn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("chunk one "));
        child.stdout.emit("data", Buffer.from("chunk two"));
        child.stderr.emit("data", Buffer.from("a warning"));
        child.emit("close", 1);
      });
      return child;
    });

    const result = await runPlaywrightTest(undefined, "/workspace");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("chunk one chunk two");
    expect(result.stderr).toBe("a warning");
  });

  it("resolves exitCode -1 when the process is killed/exits with a null code", async () => {
    const { runPlaywrightTest } = await loadWithSpawn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => child.emit("close", null));
      return child;
    });
    const result = await runPlaywrightTest(undefined, "/workspace");
    expect(result.exitCode).toBe(-1);
  });

  it("resolves (doesn't throw/hang) when spawn itself errors, e.g. npx not found", async () => {
    const { runPlaywrightTest } = await loadWithSpawn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => child.emit("error", new Error("spawn npx ENOENT")));
      return child;
    });
    const result = await runPlaywrightTest(undefined, "/workspace");
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("ENOENT");
  });
});

describe("runPlaywrightTest — JSON reporter summary parsing", () => {
  it("maps stats.expected/unexpected/skipped to passed/failed/skipped", async () => {
    const jsonOutput = JSON.stringify({ stats: { expected: 8, unexpected: 2, skipped: 1 } });
    const { runPlaywrightTest } = await loadWithSpawn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(jsonOutput));
        child.emit("close", 1);
      });
      return child;
    });

    const result = await runPlaywrightTest(undefined, "/workspace");
    expect(result.summary).toEqual({ passed: 8, failed: 2, skipped: 1 });
  });

  it("defaults missing stat fields to 0 rather than undefined/NaN", async () => {
    const jsonOutput = JSON.stringify({ stats: {} });
    const { runPlaywrightTest } = await loadWithSpawn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(jsonOutput));
        child.emit("close", 0);
      });
      return child;
    });

    const result = await runPlaywrightTest(undefined, "/workspace");
    expect(result.summary).toEqual({ passed: 0, failed: 0, skipped: 0 });
  });

  it("leaves summary undefined for non-JSON stdout (e.g. playwright not installed) rather than throwing", async () => {
    const { runPlaywrightTest } = await loadWithSpawn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("npm error: could not determine executable to run\n"));
        child.emit("close", 1);
      });
      return child;
    });

    const result = await runPlaywrightTest(undefined, "/workspace");
    expect(result.summary).toBeUndefined();
    expect(result.exitCode).toBe(1);
  });

  it("leaves summary undefined when stdout is empty", async () => {
    const { runPlaywrightTest } = await loadWithSpawn(() => {
      const child = makeFakeChild();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });
    const result = await runPlaywrightTest(undefined, "/workspace");
    expect(result.summary).toBeUndefined();
  });
});
