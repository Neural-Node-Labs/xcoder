// ronin:version 1 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:43:53.321Z | ronin:subtask code-st-f034f3
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProcedureEngine } from "../ProcedureEngine.js";
import { LlmClient, LlmResponse, TelemetryInterface } from "../../types.js";
import { EngineDeps } from "../EngineRegistry.js";
import { Procedure } from "../../workflows/types.js";

function makeDeps(overrides: Partial<EngineDeps> = {}): EngineDeps {
  const llm: LlmClient = {
    complete: vi.fn(async (): Promise<LlmResponse> => ({
      content: "",
      toolCalls: [],
      reasoningContent: undefined,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })),
  };
  const telemetry: TelemetryInterface = {
    logThought: vi.fn(async () => {}),
    logLlmCall: vi.fn(async () => {}),
    logError: vi.fn(async () => {}),
  };
  return { llm, telemetry, options: { cwd: process.cwd() }, ...overrides };
}

describe("ProcedureEngine", () => {
  describe("AC-5: scripted procedure smoke run", () => {
    it("generates then executes a trivial local shell step and returns its output", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proc-ac5-"));
      const deps = makeDeps({ options: { cwd: dir } });
      const engine = new ProcedureEngine(deps);

      // AC-5 seam: inject a scripted procedure generator (no LLM needed for generation).
      const procedureFn = vi.fn(async (): Promise<Procedure> => ({
        procedureId: "proc-ac5",
        steps: [
          {
            stepId: "s1",
            name: "echo done",
            action: "shell",
            command: "echo done",
            dependsOn: [],
            onFailure: "halt",
            maxRetries: 1,
          },
        ],
      }));
      (engine as unknown as { generate: typeof procedureFn }).generate = procedureFn;

      const answer = await engine.run("run a trivial procedure");

      expect(procedureFn).toHaveBeenCalledTimes(1);
      expect(answer).toContain("done");
      expect(engine.getLastOutcome()).toBe("completed");
      expect(engine.getState()).toEqual({ phase: "completed", task: "run a trivial procedure", outcome: "completed" });
    });

    it("reports halted when a halt-on-failure step fails", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proc-halt-"));
      const deps = makeDeps({ options: { cwd: dir } });
      const engine = new ProcedureEngine(deps);

      const procedureFn = vi.fn(async (): Promise<Procedure> => ({
        procedureId: "proc-halt",
        steps: [
          {
            stepId: "s1",
            name: "fail",
            action: "shell",
            command: "this-command-definitely-does-not-exist-xyz",
            dependsOn: [],
            onFailure: "halt",
            maxRetries: 1,
          },
        ],
      }));
      (engine as unknown as { generate: typeof procedureFn }).generate = procedureFn;

      const answer = await engine.run("run a failing procedure");

      expect(answer).toContain("halted");
      expect(engine.getLastOutcome()).toBe("partial_completion");
    });
  });

  describe("lifecycle surface", () => {
    it("reports workspace path from options.cwd", () => {
      const engine = new ProcedureEngine(makeDeps({ options: { cwd: "/tmp/proc" } }));
      expect(engine.getWorkspacePath()).toBe("/tmp/proc");
    });
  });
});
