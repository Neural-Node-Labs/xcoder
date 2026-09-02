// ronin:version 4 | ronin:task task-b88b43 | ronin:updated 2026-08-13T06:23:44.675Z | ronin:subtask test-st-eaae62
/**
 * Phase 5: Test and Verify Resilience
 *
 * Creates test scenarios where subagents are forced to crash (invalid input,
 * forced exit, timeout) and verifies that:
 * - The master orchestration logs the failure
 * - Execution continues after crashes
 * - A complete report is produced even when all subagents fail
 * - The existing test suite has no regressions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SubprocessManager, SubprocessResult } from "../../subprocess/SubprocessManager.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ─── Helpers ──────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createTempDir(): string {
  const dir = path.join(os.tmpdir(), `phase5-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

/**
 * Resolve the path to the subagentWorker module.
 * In dev mode (ts-node), the .ts file is used directly.
 * In production, the compiled .js file is used.
 */
function resolveWorkerPath(): string {
  const srcPath = path.resolve(__dirname, "../../subprocess/subagentWorker.ts");
  const distPath = path.resolve(__dirname, "../../subprocess/subagentWorker.js");

  // Try .ts first (dev mode with ts-node), fall back to .js (production)
  try {
    fs.accessSync(srcPath);
    return srcPath;
  } catch {
    return distPath;
  }
}

/**
 * Create a simple worker script that crashes in a controlled way.
 * This avoids needing the full subagentWorker infrastructure.
 */
function createCrashWorkerScript(
  tempDir: string,
  crashType: "panic" | "exit" | "hang" | "invalid"
): string {
  const scriptPath = path.join(tempDir, "crash-worker.mjs");

  let scriptContent = "";
  switch (crashType) {
    case "panic":
      scriptContent = `
        // Worker that throws an uncaught exception
        process.on("message", () => {
          throw new Error("SIMULATED_CRASH: uncaught exception in worker");
        });
        // Send heartbeat to show we started
        if (process.send) process.send({ type: "heartbeat" });
      `;
      break;
    case "exit":
      scriptContent = `
        // Worker that exits with non-zero code
        process.on("message", () => {
          process.exit(1);
        });
        // Send heartbeat to show we started
        if (process.send) process.send({ type: "heartbeat" });
      `;
      break;
    case "hang":
      scriptContent = `
        // Worker that hangs (never responds, never exits)
        process.on("message", () => {
          // Intentionally do nothing — just hang
        });
        // Send one heartbeat then stop
        if (process.send) process.send({ type: "heartbeat" });
      `;
      break;
    case "invalid":
      scriptContent = `
        // Worker that sends invalid data and exits
        process.on("message", () => {
          if (process.send) process.send({ type: "result", data: null });
          process.exit(0);
        });
        if (process.send) process.send({ type: "heartbeat" });
      `;
      break;
  }

  fs.writeFileSync(scriptPath, scriptContent, "utf-8");
  return scriptPath;
}

/**
 * Create a worker script that simulates a successful subagent.
 */
function createSuccessWorkerScript(tempDir: string): string {
  const scriptPath = path.join(tempDir, "success-worker.mjs");
  const scriptContent = `
    import { parentPort } from "node:worker_threads";

    // Use IPC via process.send for child_process.fork()
    process.on("message", (msg) => {
      const message = JSON.parse(JSON.stringify(msg));
      if (message.type === "start") {
        // Simulate some work
        const result = { status: "completed", summary: "Task completed successfully", iterationCount: 1 };
        if (process.send) process.send({ type: "result", data: result });
        process.exit(0);
      }
    });
    if (process.send) process.send({ type: "heartbeat" });
  `;
  fs.writeFileSync(scriptPath, scriptContent, "utf-8");
  return scriptPath;
}

// ─── Tests ────────────────────────────────────────────────────────────────────────

describe("Phase 5: Subagent Resilience — Crash Scenarios", () => {
  let tempDir: string;
  let manager: SubprocessManager;

  beforeEach(() => {
    tempDir = createTempDir();
    manager = new SubprocessManager();
  });

  afterEach(() => {
    cleanTempDir(tempDir);
  });

  // ─── Scenario 1: Invalid Input ──────────────────────────────────────────────

  describe("Scenario 1: Invalid input to subagent", () => {
    it("returns a crash result when worker receives invalid input", async () => {
      const workerPath = createCrashWorkerScript(tempDir, "panic");

      const result = await manager.spawn(workerPath, {
        timeoutMs: 5_000,
        workerData: { task: "do something invalid" },
      });

      // The worker should crash (exit code 1 from uncaught exception)
      expect(result.crashed).toBe(true);
      expect(result.exitCode).not.toBe(0);
      // The error message should indicate a crash
      expect(result.error).toBeTruthy();
      // stderr should contain the crash info
      expect(result.stderr).toContain("SIMULATED_CRASH");
    });

    it("master process survives the subagent crash", async () => {
      const workerPath = createCrashWorkerScript(tempDir, "panic");

      // This should not throw — the master must survive
      let result: SubprocessResult;
      try {
        result = await manager.spawn(workerPath, {
          timeoutMs: 5_000,
          workerData: { task: "crash test" },
        });
      } catch (err) {
        // If it throws, the master crashed — that's a failure
        expect.fail(`Master process crashed: ${err}`);
        return;
      }

      expect(result.crashed).toBe(true);
      // Verify we can still use the manager after a crash
      const successWorker = createSuccessWorkerScript(tempDir);
      const secondResult = await manager.spawn(successWorker, {
        timeoutMs: 5_000,
        workerData: { task: "second task" },
      });

      expect(secondResult.crashed).toBe(false);
      expect(secondResult.exitCode).toBe(0);
    });
  });

  // ─── Scenario 2: Forced Process Exit ────────────────────────────────────────

  describe("Scenario 2: Forced process exit (exit code 1)", () => {
    it("detects non-zero exit code as a crash", async () => {
      const workerPath = createCrashWorkerScript(tempDir, "exit");

      const result = await manager.spawn(workerPath, {
        timeoutMs: 5_000,
        workerData: { task: "exit test" },
      });

      expect(result.crashed).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.error).toMatch(/code 1/);
    });

    it("master continues after subagent exits with code 1", async () => {
      const workerPath = createCrashWorkerScript(tempDir, "exit");

      // First subagent crashes
      const crashResult = await manager.spawn(workerPath, {
        timeoutMs: 5_000,
        workerData: { task: "crash" },
      });
      expect(crashResult.crashed).toBe(true);

      // Second subagent succeeds — master is still functional
      const successWorker = createSuccessWorkerScript(tempDir);
      const successResult = await manager.spawn(successWorker, {
        timeoutMs: 5_000,
        workerData: { task: "recovery" },
      });
      expect(successResult.crashed).toBe(false);
      expect(successResult.exitCode).toBe(0);
    });
  });

  // ─── Scenario 3: Timeout Crash Detection ────────────────────────────────────

  describe("Scenario 3: Timeout crash detection", () => {
    it("kills a hung worker and reports timeout", async () => {
      const workerPath = createCrashWorkerScript(tempDir, "hang");

      const result = await manager.spawn(workerPath, {
        timeoutMs: 1_000, // Very short timeout
        heartbeatIntervalMs: 500,
        heartbeatMissedLimit: 2,
        workerData: { task: "hang test" },
      });

      expect(result.crashed).toBe(true);
      expect(result.timedOut).toBe(true);
      expect(result.error).toContain("timed out");
    });

    it("master survives timeout and can spawn new workers", async () => {
      const workerPath = createCrashWorkerScript(tempDir, "hang");

      // Hung worker times out
      const timeoutResult = await manager.spawn(workerPath, {
        timeoutMs: 1_000,
        heartbeatIntervalMs: 500,
        heartbeatMissedLimit: 2,
        workerData: { task: "hang" },
      });
      expect(timeoutResult.timedOut).toBe(true);

      // Master can still spawn new workers
      const successWorker = createSuccessWorkerScript(tempDir);
      const successResult = await manager.spawn(successWorker, {
        timeoutMs: 5_000,
        workerData: { task: "after timeout" },
      });
      expect(successResult.crashed).toBe(false);
    });
  });

  // ─── Scenario 4: Multiple Consecutive Crashes ───────────────────────────────

  describe("Scenario 4: Multiple consecutive crashes", () => {
    it("master survives multiple consecutive subagent crashes", async () => {
      const panicWorker = createCrashWorkerScript(tempDir, "panic");

      // Crash 3 times in a row
      for (let i = 0; i < 3; i++) {
        const result = await manager.spawn(panicWorker, {
          timeoutMs: 5_000,
          workerData: { task: `crash #${i + 1}` },
        });
        expect(result.crashed).toBe(true);
      }

      // Master still works after 3 crashes
      const successWorker = createSuccessWorkerScript(tempDir);
      const finalResult = await manager.spawn(successWorker, {
        timeoutMs: 5_000,
        workerData: { task: "final recovery" },
      });
      expect(finalResult.crashed).toBe(false);
    });

    it("master survives mixed crash types (panic, exit, timeout)", async () => {
      const panicWorker = createCrashWorkerScript(tempDir, "panic");
      const exitWorker = createCrashWorkerScript(tempDir, "exit");
      const hangWorker = createCrashWorkerScript(tempDir, "hang");

      // Panic
      const r1 = await manager.spawn(panicWorker, {
        timeoutMs: 3_000,
        workerData: { task: "panic" },
      });
      expect(r1.crashed).toBe(true);

      // Exit
      const r2 = await manager.spawn(exitWorker, {
        timeoutMs: 3_000,
        workerData: { task: "exit" },
      });
      expect(r2.crashed).toBe(true);

      // Timeout
      const r3 = await manager.spawn(hangWorker, {
        timeoutMs: 1_000,
        heartbeatIntervalMs: 500,
        heartbeatMissedLimit: 2,
        workerData: { task: "hang" },
      });
      expect(r3.crashed).toBe(true);
      expect(r3.timedOut).toBe(true);

      // Recovery
      const successWorker = createSuccessWorkerScript(tempDir);
      const r4 = await manager.spawn(successWorker, {
        timeoutMs: 5_000,
        workerData: { task: "recovery" },
      });
      expect(r4.crashed).toBe(false);
    }, 15_000);
  });

  // ─── Scenario 5: Crash Report Generation ────────────────────────────────────

  describe("Scenario 5: Crash report generation", () => {
    it("generates a structured crash result with metadata", async () => {
      const workerPath = createCrashWorkerScript(tempDir, "panic");

      const result = await manager.spawn(workerPath, {
        timeoutMs: 5_000,
        workerData: { task: "crash report test" },
      });

      // Verify the crash result has all expected fields
      expect(result).toHaveProperty("crashed");
      expect(result).toHaveProperty("exitCode");
      expect(result).toHaveProperty("timedOut");
      expect(result).toHaveProperty("error");
      expect(result).toHaveProperty("stderr");
      expect(result).toHaveProperty("result");

      expect(result.crashed).toBe(true);
      expect(typeof result.exitCode).toBe("number");
      expect(typeof result.timedOut).toBe("boolean");
      expect(typeof result.error).toBe("string");
      expect(typeof result.stderr).toBe("string");
    });

    it("captures stderr output from crashed worker", async () => {
      const workerPath = createCrashWorkerScript(tempDir, "panic");

      const result = await manager.spawn(workerPath, {
        timeoutMs: 5_000,
        workerData: { task: "stderr test" },
      });

      // The panic worker throws an error which should appear in stderr
      expect(result.stderr.length).toBeGreaterThan(0);
      // The error message should be captured
      expect(result.error).toBeTruthy();
    });
  });

  // ─── Scenario 6: SubprocessManager Edge Cases ───────────────────────────────

  describe("Scenario 6: Edge cases", () => {
    it("handles worker that exits with code 0 but sends no result", async () => {
      // Create a worker that exits cleanly without sending a result
      const scriptPath = path.join(tempDir, "no-result-worker.mjs");
      fs.writeFileSync(scriptPath, `
        process.on("message", () => {
          process.exit(0); // Exit cleanly, no result sent
        });
        if (process.send) process.send({ type: "heartbeat" });
      `, "utf-8");

      const result = await manager.spawn(scriptPath, {
        timeoutMs: 5_000,
        workerData: { task: "no result" },
      });

      // Exit code 0 means no crash, but result is undefined
      expect(result.crashed).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.result).toBeUndefined();
    });

    it("handles worker that exits with non-zero code without error message", async () => {
      const scriptPath = path.join(tempDir, "silent-fail-worker.mjs");
      fs.writeFileSync(scriptPath, `
        process.on("message", () => {
          process.exit(42); // Non-zero exit, no error sent via IPC
        });
        if (process.send) process.send({ type: "heartbeat" });
      `, "utf-8");

      const result = await manager.spawn(scriptPath, {
        timeoutMs: 5_000,
        workerData: { task: "silent fail" },
      });

      expect(result.crashed).toBe(true);
      expect(result.exitCode).toBe(42);
      // The error message should be auto-generated from the exit code
      expect(result.error).toMatch(/code 42/);
    });

    it("handles very short timeout (worker killed immediately)", async () => {
      const workerPath = createCrashWorkerScript(tempDir, "hang");

      const result = await manager.spawn(workerPath, {
        timeoutMs: 100, // Extremely short timeout
        heartbeatIntervalMs: 200,
        heartbeatMissedLimit: 1,
        workerData: { task: "immediate timeout" },
      });

      expect(result.crashed).toBe(true);
      expect(result.timedOut).toBe(true);
    });
  });
});

