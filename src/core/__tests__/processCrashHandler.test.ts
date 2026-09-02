import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  installProcessCrashHandler,
  generateCrashReport,
  isCrashHandlerInstalled,
  resetCrashHandlerState,
  CrashReport,
} from "../processCrashHandler.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Helpers ──────────────────────────────────────────────────────────────────────

function createTempDir(): string {
  const dir = path.join(os.tmpdir(), `crash-handler-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

// ─── Tests ────────────────────────────────────────────────────────────────────────

describe("processCrashHandler", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    resetCrashHandlerState();
  });

  afterEach(() => {
    cleanTempDir(tempDir);
    // Restore any mocked process methods
    vi.restoreAllMocks();
  });

  // ─── installProcessCrashHandler ─────────────────────────────────────────────

  describe("installProcessCrashHandler", () => {
    it("registers uncaughtException and unhandledRejection handlers", () => {
      const onSpy = vi.spyOn(process, "on");

      installProcessCrashHandler(tempDir);

      expect(onSpy).toHaveBeenCalledWith("uncaughtException", expect.any(Function));
      expect(onSpy).toHaveBeenCalledWith("unhandledRejection", expect.any(Function));
      expect(isCrashHandlerInstalled()).toBe(true);
    });

    it("prevents double-registration", () => {
      const onSpy = vi.spyOn(process, "on");

      installProcessCrashHandler(tempDir);
      installProcessCrashHandler(tempDir);
      installProcessCrashHandler(tempDir);

      // process.on should only have been called twice (once for each event type)
      expect(onSpy).toHaveBeenCalledTimes(2);
    });

    it("sets installed flag to true after installation", () => {
      expect(isCrashHandlerInstalled()).toBe(false);
      installProcessCrashHandler(tempDir);
      expect(isCrashHandlerInstalled()).toBe(true);
    });
  });

  // ─── generateCrashReport ────────────────────────────────────────────────────

  describe("generateCrashReport", () => {
    it("writes a crash report file to .agent/reports/ directory", () => {
      const report: CrashReport = {
        timestamp: "2025-01-15T10:30:00.000Z",
        message: "Test error message",
        stack: "Error: Test error message\n    at Object.<anonymous> (test.ts:1:1)",
        crashType: "uncaughtException",
        nodeVersion: "v20.0.0",
        argv: ["node", "test.js"],
        cwd: tempDir,
        platform: "linux",
      };

      const reportPath = generateCrashReport(tempDir, report);

      // Verify the report file exists
      expect(fs.existsSync(reportPath)).toBe(true);

      // Verify the report content
      const content = fs.readFileSync(reportPath, "utf-8");
      expect(content).toContain("# Crash Report");
      expect(content).toContain("Test error message");
      expect(content).toContain("uncaughtException");
      expect(content).toContain("v20.0.0");
      expect(content).toContain("test.ts:1:1");
      expect(content).toContain("Walang awtomatikong pagsisimula muli");
    });

    it("handles missing stack trace gracefully", () => {
      const report: CrashReport = {
        timestamp: "2025-01-15T10:30:00.000Z",
        message: "Error without stack",
        stack: undefined,
        crashType: "unhandledRejection",
        nodeVersion: "v20.0.0",
        argv: ["node", "test.js"],
        cwd: tempDir,
        platform: "linux",
      };

      const reportPath = generateCrashReport(tempDir, report);

      expect(fs.existsSync(reportPath)).toBe(true);
      const content = fs.readFileSync(reportPath, "utf-8");
      expect(content).toContain("Error without stack");
      expect(content).toContain("unhandledRejection");
      // Should NOT contain a stack trace section header
      expect(content).not.toContain("## Stack Trace");
    });

    it("creates the reports directory if it doesn't exist", () => {
      const reportsDir = path.join(tempDir, ".agent", "reports");
      expect(fs.existsSync(reportsDir)).toBe(false);

      const report: CrashReport = {
        timestamp: "2025-01-15T10:30:00.000Z",
        message: "Test",
        crashType: "uncaughtException",
        nodeVersion: "v20.0.0",
        argv: ["node", "test.js"],
        cwd: tempDir,
        platform: "linux",
      };

      generateCrashReport(tempDir, report);

      expect(fs.existsSync(reportsDir)).toBe(true);
    });

    it("generates unique filenames for different timestamps", () => {
      const report1: CrashReport = {
        timestamp: "2025-01-15T10:30:00.000Z",
        message: "First crash",
        crashType: "uncaughtException",
        nodeVersion: "v20.0.0",
        argv: ["node", "test.js"],
        cwd: tempDir,
        platform: "linux",
      };

      const report2: CrashReport = {
        timestamp: "2025-01-15T10:31:00.000Z",
        message: "Second crash",
        crashType: "unhandledRejection",
        nodeVersion: "v20.0.0",
        argv: ["node", "test.js"],
        cwd: tempDir,
        platform: "linux",
      };

      const path1 = generateCrashReport(tempDir, report1);
      const path2 = generateCrashReport(tempDir, report2);

      expect(path1).not.toBe(path2);
      expect(fs.existsSync(path1)).toBe(true);
      expect(fs.existsSync(path2)).toBe(true);
    });
  });

  // ─── resetCrashHandlerState ─────────────────────────────────────────────────

  describe("resetCrashHandlerState", () => {
    it("resets the installed flag to false", () => {
      installProcessCrashHandler(tempDir);
      expect(isCrashHandlerInstalled()).toBe(true);

      resetCrashHandlerState();
      expect(isCrashHandlerInstalled()).toBe(false);
    });

    it("allows re-installation after reset", () => {
      const onSpy = vi.spyOn(process, "on");

      installProcessCrashHandler(tempDir);
      expect(onSpy).toHaveBeenCalledTimes(2);

      resetCrashHandlerState();

      installProcessCrashHandler(tempDir);
      // Should have been called 2 more times (total 4)
      expect(onSpy).toHaveBeenCalledTimes(4);
    });
  });

  // ─── Crash handler behavior (integration-style) ─────────────────────────────

  describe("crash handler behavior", () => {
    it("calls process.exit(1) when an uncaught exception occurs", () => {
      // Mock process.exit to prevent actual process termination
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        // Don't actually exit
      }) as unknown as (code: number | string | null | undefined) => never);

      // Mock console.error to suppress output
      vi.spyOn(console, "error").mockImplementation(() => {});

      installProcessCrashHandler(tempDir);

      // Simulate an uncaught exception
      const error = new Error("Test crash");
      process.emit("uncaughtException", error);

      // Verify process.exit was called with code 1
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("calls process.exit(1) when an unhandled rejection occurs", () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        // Don't actually exit
      }) as unknown as (code: number | string | null | undefined) => never);

      vi.spyOn(console, "error").mockImplementation(() => {});

      installProcessCrashHandler(tempDir);

      // Simulate an unhandled rejection — use a string reason to avoid type issues
      process.emit("unhandledRejection" as any, new Error("Test rejection"));

      // Verify process.exit was called with code 1
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("generates a crash report file on uncaught exception", () => {
      vi.spyOn(process, "exit").mockImplementation((() => {
        // Don't actually exit
      }) as unknown as (code: number | string | null | undefined) => never);

      vi.spyOn(console, "error").mockImplementation(() => {});

      installProcessCrashHandler(tempDir);

      const error = new Error("Integration test crash");
      error.stack = "Error: Integration test crash\n    at test.ts:10:10";
      process.emit("uncaughtException", error);

      // Check that a crash report was written
      const reportsDir = path.join(tempDir, ".agent", "reports");
      expect(fs.existsSync(reportsDir)).toBe(true);

      const files = fs.readdirSync(reportsDir);
      expect(files.length).toBeGreaterThan(0);

      const crashFile = files.find((f) => f.startsWith("crash-"));
      expect(crashFile).toBeDefined();

      const content = fs.readFileSync(path.join(reportsDir, crashFile!), "utf-8");
      expect(content).toContain("Integration test crash");
      expect(content).toContain("uncaughtException");
    });

    it("debounces rapid successive crashes", () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        // Don't actually exit
      }) as unknown as (code: number | string | null | undefined) => never);

      vi.spyOn(console, "error").mockImplementation(() => {});

      installProcessCrashHandler(tempDir);

      // Emit two crashes in rapid succession
      process.emit("uncaughtException", new Error("First crash"));
      process.emit("uncaughtException", new Error("Second crash (debounced)"));

      // process.exit should have been called twice (once for each crash)
      // The second call goes through the debounce path which still calls exit(1)
      expect(exitSpy).toHaveBeenCalledTimes(2);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("does NOT attempt restart or retry (single exit only)", () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        // Don't actually exit
      }) as unknown as (code: number | string | null | undefined) => never);

      vi.spyOn(console, "error").mockImplementation(() => {});

      installProcessCrashHandler(tempDir);

      process.emit("uncaughtException", new Error("No restart test"));

      // Verify exit code is 1 (failure), not 0 (success/restart)
      expect(exitSpy).toHaveBeenCalledWith(1);

      // Verify there's no restart logic by checking the crash report content
      const reportsDir = path.join(tempDir, ".agent", "reports");
      const files = fs.readdirSync(reportsDir);
      const crashFile = files.find((f) => f.startsWith("crash-"));
      expect(crashFile).toBeDefined();

      const content = fs.readFileSync(path.join(reportsDir, crashFile!), "utf-8");
      expect(content).toContain("Walang awtomatikong pagsisimula muli");
    });
  });
});
