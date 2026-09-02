import { describe, it, expect, vi, beforeEach } from "vitest";
import { LeanEngine } from "../LeanEngine.js";
import { LlmClient, LlmResponse, LlmUsage, TelemetryInterface, ToolCall } from "../../types.js";
import { EngineState, RunOutcome } from "../IReactEngine.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────────

function makeUsage(overrides: Partial<LlmUsage> = {}): LlmUsage {
  return {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    reasoningTokens: 0,
    cachedTokens: 0,
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "call_1",
    type: "function",
    function: { name: "read_tool", arguments: '{"filePath":"test.txt"}' },
    ...overrides,
  };
}

function makeResponse(overrides: Partial<LlmResponse> = {}): LlmResponse {
  return {
    content: "Let me read that file.",
    toolCalls: [],
    reasoningContent: undefined,
    usage: makeUsage(),
    ...overrides,
  };
}

// ─── Mock LLM client ──────────────────────────────────────────────────────────────

function createMockLlm(responses?: LlmResponse[]): LlmClient {
  const defaultResponse = makeResponse({ content: "Task completed successfully." });
  let callIndex = 0;
  return {
    complete: vi.fn(async (_messages, _opts?) => {
      const resp = responses ? responses[callIndex++] ?? defaultResponse : defaultResponse;
      return resp;
    }),
  };
}

/**
 * Creates an LLM mock that always returns the same response, regardless of how many
 * times it's called. Useful for tests where the LLM should behave identically on every
 * iteration (e.g., always returning a tool call to test iteration limits).
 */
function createRepeatingMockLlm(response: LlmResponse): LlmClient {
  return {
    complete: vi.fn(async () => response),
  };
}

// ─── Mock telemetry ───────────────────────────────────────────────────────────────

function createMockTelemetry(): TelemetryInterface {
  return {
    logThought: vi.fn(async () => {}),
    logLlmCall: vi.fn(async () => {}),
    logError: vi.fn(async () => {}),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────────

describe("LeanEngine", () => {
  let llm: LlmClient;
  let telemetry: TelemetryInterface;

  beforeEach(() => {
    llm = createMockLlm();
    telemetry = createMockTelemetry();
  });

  // ── Construction & defaults ────────────────────────────────────────────────────

  describe("construction", () => {
    it("creates an engine with default options", () => {
      const engine = new LeanEngine(llm, telemetry);
      expect(engine).toBeInstanceOf(LeanEngine);
      expect(engine.getState()).toEqual({ phase: "idle" });
    });

    it("creates an engine with custom options", () => {
      const engine = new LeanEngine(llm, telemetry, {
        maxIterations: 5,
        cwd: "/tmp/test",
        validateGoal: false,
        selfHealing: false,
        consoleThoughts: false,
      });
      expect(engine).toBeInstanceOf(LeanEngine);
    });
  });

  // ── IReactEngineV2 lifecycle ───────────────────────────────────────────────────

  describe("lifecycle (IReactEngineV2)", () => {
    it("starts in idle state", () => {
      const engine = new LeanEngine(llm, telemetry);
      expect(engine.getState()).toEqual({ phase: "idle" });
    });

    it("transitions to running during execution", async () => {
      const engine = new LeanEngine(llm, telemetry, { maxIterations: 1, validateGoal: false });
      const states: EngineState[] = [];
      engine.onProgress((s) => states.push(s));

      const result = await engine.run("test task");

      expect(result).toBe("Task completed successfully.");
      // Should have seen running and completed states
      const runningStates = states.filter((s) => s.phase === "running");
      expect(runningStates.length).toBeGreaterThanOrEqual(1);
      const completedState = states.find((s) => s.phase === "completed");
      expect(completedState).toBeDefined();
      if (completedState && completedState.phase === "completed") {
        expect(completedState.outcome).toBe("completed");
      }
    });

    it("supports cancellation", async () => {
      // Create an LLM that returns a tool call (so the loop continues), then we cancel
      const toolCallResponse = makeResponse({
        content: "Let me read that file.",
        toolCalls: [makeToolCall()],
      });
      // After cancellation, the LLM should return a completion (but the engine should stop before calling it)
      const completionResponse = makeResponse({
        content: "Task completed.",
        toolCalls: [],
      });
      // Use a mock that delays on the FIRST call so cancellation can be set before
      // the LLM call completes. The tool dispatch is synchronous, so after the first
      // tool call returns, the loop checks cancellation before the next LLM call.
      let callCount = 0;
      const delayedLlm: LlmClient = {
        complete: vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            // Delay the first LLM call to give cancel() time to fire
            await new Promise((r) => setTimeout(r, 50));
            return toolCallResponse;
          }
          return completionResponse;
        }),
      };
      const engine = new LeanEngine(delayedLlm, telemetry, { maxIterations: 10, validateGoal: false });

      // Start the run — the first LLM call will be delayed by 50ms
      const runPromise = engine.run("test task");

      // Cancel after a short delay — fires during the first LLM call's delay
      setTimeout(() => engine.cancel("test cancellation"), 10);

      const result = await runPromise;
      expect(result).toContain("cancelled");
      expect(engine.getLastOutcome()).toBe("partial_success");
      const state = engine.getState();
      expect(state.phase).toBe("cancelled");
    });

    it("cancel is idempotent when already idle", () => {
      const engine = new LeanEngine(llm, telemetry);
      // Should not throw
      engine.cancel("already idle");
      expect(engine.getState()).toEqual({ phase: "idle" });
    });

    it("supports progress observers", async () => {
      const engine = new LeanEngine(llm, telemetry, { maxIterations: 1, validateGoal: false });
      const observer = vi.fn();
      const unsubscribe = engine.onProgress(observer);

      await engine.run("test task");

      expect(observer).toHaveBeenCalled();
      // Should have been called at least once (for completed state)
      const completedCalls = observer.mock.calls.filter(
        (c) => c[0].phase === "completed"
      );
      expect(completedCalls.length).toBe(1);

      // Unsubscribe should work
      unsubscribe();
      observer.mockClear();
    });

    it("observer errors do not crash the engine", async () => {
      const engine = new LeanEngine(llm, telemetry, { maxIterations: 1, validateGoal: false });
      engine.onProgress(() => {
        throw new Error("observer error");
      });

      // Should not throw despite the observer error
      const result = await engine.run("test task");
      expect(result).toBe("Task completed successfully.");
    });

    it("getLastMessages returns message history after run", async () => {
      const engine = new LeanEngine(llm, telemetry, { maxIterations: 1, validateGoal: false });
      await engine.run("test task");

      const messages = engine.getLastMessages();
      expect(messages.length).toBeGreaterThanOrEqual(2); // system + user at minimum
      expect(messages[0].role).toBe("system");
      expect(messages[1].role).toBe("user");
    });

    it("getLastMessages returns empty array before any run", () => {
      const engine = new LeanEngine(llm, telemetry);
      expect(engine.getLastMessages()).toEqual([]);
    });

    it("getWorkspacePath returns cwd", () => {
      const engine = new LeanEngine(llm, telemetry, { cwd: "/custom/path" });
      expect(engine.getWorkspacePath()).toBe("/custom/path");
    });

    it("getIterationCount returns 0 before any run", () => {
      const engine = new LeanEngine(llm, telemetry);
      expect(engine.getIterationCount()).toBe(0);
    });

    it("getIterationCount returns iteration count after run", async () => {
      const engine = new LeanEngine(llm, telemetry, { maxIterations: 1, validateGoal: false });
      await engine.run("test task");
      expect(engine.getIterationCount()).toBe(1);
    });
  });

  // ── IReactEngine interface ─────────────────────────────────────────────────────

  describe("IReactEngine interface", () => {
    it("getLastOutcome returns 'completed' after successful run", async () => {
      const engine = new LeanEngine(llm, telemetry, { maxIterations: 1, validateGoal: false });
      await engine.run("test task");
      expect(engine.getLastOutcome()).toBe("completed");
    });

    it("getCumulativeUsage returns usage data", async () => {
      const engine = new LeanEngine(llm, telemetry, { maxIterations: 1, validateGoal: false });
      await engine.run("test task");
      const usage = engine.getCumulativeUsage();
      expect(usage.totalTokens).toBeGreaterThan(0);
      expect(usage.promptTokens).toBeGreaterThan(0);
    });

    it("getCumulativeUsage returns a copy, not the internal object", () => {
      const engine = new LeanEngine(llm, telemetry);
      const usage1 = engine.getCumulativeUsage();
      const usage2 = engine.getCumulativeUsage();
      // Modifying one should not affect the other
      usage1.totalTokens = 999;
      expect(usage2.totalTokens).not.toBe(999);
    });

    it("getHealthScore returns 100 when no steps scored", () => {
      const engine = new LeanEngine(llm, telemetry);
      expect(engine.getHealthScore()).toBe(100);
    });

    it("getPartialSuccess returns undefined when no partial success", () => {
      const engine = new LeanEngine(llm, telemetry);
      expect(engine.getPartialSuccess()).toBeUndefined();
    });

    it("getSubagentLimitContext returns undefined when no subagent limit", () => {
      const engine = new LeanEngine(llm, telemetry);
      expect(engine.getSubagentLimitContext()).toBeUndefined();
    });

    it("selectSkills returns empty array for unknown task", () => {
      const engine = new LeanEngine(llm, telemetry);
      const skills = engine.selectSkills("some random task with no matching skill");
      expect(skills).toEqual([]);
    });

    it("generatePlan returns a plan string", async () => {
      const engine = new LeanEngine(llm, telemetry);
      const plan = await engine.generatePlan("test task");
      expect(plan).toContain("Plan");
      expect(plan).toContain("test task");
    });
  });

  // ── Run behavior ───────────────────────────────────────────────────────────────

  describe("run behavior", () => {
    it("executes a simple task to completion", async () => {
      const engine = new LeanEngine(llm, telemetry, { maxIterations: 5, validateGoal: false });
      const result = await engine.run("Do something simple");
      expect(result).toBe("Task completed successfully.");
      expect(engine.getLastOutcome()).toBe("completed");
    });

    it("handles tool calls from the LLM", async () => {
      // LLM returns a tool call first, then a completion
      const toolCallResponse = makeResponse({
        content: "Let me read that file.",
        toolCalls: [makeToolCall()],
      });
      const completionResponse = makeResponse({
        content: "I found the file contents.",
        toolCalls: [],
      });
      const mockLlm = createMockLlm([toolCallResponse, completionResponse]);
      const engine = new LeanEngine(mockLlm, telemetry, { maxIterations: 5, validateGoal: false });

      const result = await engine.run("Read a file");
      expect(result).toBe("I found the file contents.");
      expect(engine.getLastOutcome()).toBe("completed");
    });

    it("hits iteration limit and returns partial success", async () => {
      // LLM always returns a tool call, never completes
      const toolCallResponse = makeResponse({
        content: "Still working...",
        toolCalls: [makeToolCall()],
      });
      const mockLlm = createRepeatingMockLlm(toolCallResponse);
      const engine = new LeanEngine(mockLlm, telemetry, { maxIterations: 2, validateGoal: false });

      const result = await engine.run("Complex task");
      expect(engine.getLastOutcome()).toBe("partial_success");
      // Should have a synthesized report
      expect(result.length).toBeGreaterThan(10);
    });

    it("respects maxIterations option", async () => {
      const toolCallResponse = makeResponse({
        content: "Still working...",
        toolCalls: [makeToolCall()],
      });
      const mockLlm = createRepeatingMockLlm(toolCallResponse);
      const engine = new LeanEngine(mockLlm, telemetry, { maxIterations: 3, validateGoal: false });

      await engine.run("Complex task");
      // The check is `iteration > maxIterations`, so iteration 4 triggers the limit.
      // iterationCount is incremented before the check, so it will be 4 when the limit is hit.
      // This means maxIterations=3 allows 3 full iterations before stopping on the 4th.
      expect(engine.getIterationCount()).toBe(4);
      expect(engine.getLastOutcome()).toBe("partial_success");
    });

    it("supports goal validation when enabled", async () => {
      // LLM returns a completion, then validator is called
      const completionResponse = makeResponse({
        content: "Task completed successfully.",
        toolCalls: [],
      });
      const mockLlm = createMockLlm([completionResponse]);
      const engine = new LeanEngine(mockLlm, telemetry, { maxIterations: 5, validateGoal: true });

      const result = await engine.run("Do something");
      expect(result).toBe("Task completed successfully.");
    });

    it("handles LLM errors gracefully", async () => {
      const failingLlm: LlmClient = {
        complete: vi.fn(async () => {
          throw new Error("LLM API error");
        }),
      };
      const engine = new LeanEngine(failingLlm, telemetry, { maxIterations: 1, validateGoal: false });

      await expect(engine.run("test task")).rejects.toThrow("LLM API error");
      const state = engine.getState();
      expect(state.phase).toBe("error");
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty task description", async () => {
      const engine = new LeanEngine(llm, telemetry, { maxIterations: 1, validateGoal: false });
      const result = await engine.run("");
      expect(result).toBe("Task completed successfully.");
    });

    it("handles very long task description", async () => {
      const longTask = "A".repeat(10000);
      const engine = new LeanEngine(llm, telemetry, { maxIterations: 1, validateGoal: false });
      const result = await engine.run(longTask);
      expect(result).toBe("Task completed successfully.");
    });

    it("handles LLM returning empty content", async () => {
      const emptyResponse = makeResponse({ content: "", toolCalls: [] });
      const mockLlm = createMockLlm([emptyResponse]);
      const engine = new LeanEngine(mockLlm, telemetry, { maxIterations: 1, validateGoal: false });

      const result = await engine.run("test task");
      expect(result).toBe("");
    });

    it("handles LLM returning only reasoning content", async () => {
      const reasoningResponse = makeResponse({
        content: "",
        reasoningContent: "I am thinking about this...",
        toolCalls: [],
      });
      const mockLlm = createMockLlm([reasoningResponse]);
      const engine = new LeanEngine(mockLlm, telemetry, { maxIterations: 1, validateGoal: false });

      const result = await engine.run("test task");
      expect(result).toBe("");
    });

    it("handles multiple tool calls in one response", async () => {
      const multiToolResponse = makeResponse({
        content: "Let me check multiple things.",
        toolCalls: [
          makeToolCall({ id: "call_1", function: { name: "read_tool", arguments: '{"filePath":"a.txt"}' } }),
          makeToolCall({ id: "call_2", function: { name: "read_tool", arguments: '{"filePath":"b.txt"}' } }),
        ],
      });
      const completionResponse = makeResponse({
        content: "Done checking.",
        toolCalls: [],
      });
      const mockLlm = createMockLlm([multiToolResponse, completionResponse]);
      const engine = new LeanEngine(mockLlm, telemetry, { maxIterations: 5, validateGoal: false });

      const result = await engine.run("Check files");
      expect(result).toBe("Done checking.");
    });
  });

  // ── EngineRegistry integration ─────────────────────────────────────────────────

  describe("EngineRegistry integration", () => {
    it("can be created via EngineRegistry", async () => {
      const { createEngine, listEngines } = await import("../EngineRegistry.js");
      const engines = listEngines();
      expect(engines).toContain("lean");

      const engine = createEngine("lean", { llm, telemetry });
      expect(engine).toBeInstanceOf(LeanEngine);

      const result = await engine.run("test task");
      expect(result).toBe("Task completed successfully.");
    });

    it("lean engine is listed alongside react engine", async () => {
      const { listEngines } = await import("../EngineRegistry.js");
      const engines = listEngines();
      expect(engines).toContain("react");
      expect(engines).toContain("lean");
    });
  });
});
