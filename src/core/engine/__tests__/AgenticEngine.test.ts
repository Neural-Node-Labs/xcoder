// ronin:version 3 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:55:05.006Z | ronin:subtask test-st-00cf92
import { describe, it, expect, vi } from "vitest";
import { AgenticEngine } from "../AgenticEngine.js";
import { LlmClient, LlmResponse, TelemetryInterface } from "../../types.js";
import { EngineDeps } from "../EngineRegistry.js";
import { AgentDecision, AgentRunContext, WorkflowToolContext } from "../../workflows/types.js";

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

describe("AgenticEngine", () => {
  describe("AC-4: scripted ThinkFn smoke run", () => {
    it("runs a deterministic loop to completion and returns the final answer", async () => {
      const deps = makeDeps();
      const engine = new AgenticEngine(deps);
      const think = vi.fn(async (_ctx: AgentRunContext, _tools: WorkflowToolContext): Promise<AgentDecision> => ({
        phase: "search",
        thought: "Nothing to do — task is trivially complete.",
        tool: "none",
        done: true,
        finalAnswer: "Task completed by scripted ThinkFn.",
      }));

      // Inject the scripted ThinkFn (the AC-4 seam).
      (engine as unknown as { think: typeof think }).think = think;

      const answer = await engine.run("do the thing");

      expect(answer).toBe("Task completed by scripted ThinkFn.");
      expect(engine.getLastOutcome()).toBe("completed");
      expect(engine.getState()).toEqual({ phase: "completed", task: "do the thing", outcome: "completed" });
      expect(think).toHaveBeenCalledTimes(1);
    });

    it("executes a tool decision through the workflow tool context before stopping", async () => {
      const deps = makeDeps();
      const engine = new AgenticEngine(deps);
      const think = vi.fn(async (_ctx: AgentRunContext, _tools: WorkflowToolContext): Promise<AgentDecision> => ({
        phase: "validation",
        thought: "Run a trivial command to exercise the tool facade.",
        tool: "run_command_tool",
        tool_input: "echo agentic-smoke",
        done: false,
        finalAnswer: "",
      }));
      (engine as unknown as { think: typeof think }).think = think;

      const answer = await engine.run("run the smoke command");

      expect(think).toHaveBeenCalledTimes(1);
      expect(answer).toContain("agentic-smoke");
      expect(engine.getIterationCount()).toBe(1);
    }, 30000);
  });

  describe("lifecycle surface", () => {
    it("reports workspace path from options.cwd", () => {
      const engine = new AgenticEngine(makeDeps({ options: { cwd: "/tmp/wf" } }));
      expect(engine.getWorkspacePath()).toBe("/tmp/wf");
    });

    it("cancel is idempotent on an idle engine", () => {
      const engine = new AgenticEngine(makeDeps());
      engine.cancel("nope");
      expect(engine.getState()).toEqual({ phase: "idle" });
    });
  });
});
