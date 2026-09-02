// ronin:version 1 | ronin:task task-4508cb | ronin:updated 2026-08-13T15:56:13.153Z | ronin:subtask test-st-ec8121
import { describe, it, expect, vi } from "vitest";
import { ReActOrchestrator } from "../orchestrator.js";
import { LlmClient, LlmResponse, LlmUsage, TelemetryInterface, ToolCall } from "../types.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────────

function makeUsage(): LlmUsage {
  return { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
}

function makeToolCall(): ToolCall {
  return {
    id: "call_1",
    type: "function",
    function: { name: "read_tool", arguments: '{"filePath":"test.txt"}' },
  };
}

/** Always returns a tool call, so the ReAct loop never reaches a final answer and
 *  is forced to hit the iteration limit. */
function createRepeatingToolCallLlm(): LlmClient {
  const response: LlmResponse = {
    content: "Still working...",
    toolCalls: [makeToolCall()],
    usage: makeUsage(),
  };
  return { complete: vi.fn(async () => response) };
}

function createMockTelemetry(): TelemetryInterface {
  return {
    logThought: vi.fn(async () => {}),
    logLlmCall: vi.fn(async () => {}),
    logError: vi.fn(async () => {}),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────────

describe("ReActOrchestrator maxIterations default", () => {
  it("defaults to 50 iterations when no maxIterations option is provided", async () => {
    const llm = createRepeatingToolCallLlm();
    const telemetry = createMockTelemetry();

    let limitReachedAt = -1;
    const orchestrator = new ReActOrchestrator(llm, telemetry, {
      planMode: "never",
      validateGoal: false,
      consoleThoughts: false,
      // Capture the iteration count reported when the limit fires. The orchestrator
      // calls this with `iteration - 1` when `iteration > maxIterations`, so the value
      // equals the effective maxIterations ceiling.
      onIterationLimitReached: async (_task, iteration) => {
        limitReachedAt = iteration;
        return false; // decline continuation so the run stops
      },
    });

    await orchestrator.run("test task");

    expect(limitReachedAt).toBe(50);
  });

  it("respects an explicit maxIterations override", async () => {
    const llm = createRepeatingToolCallLlm();
    const telemetry = createMockTelemetry();

    let limitReachedAt = -1;
    const orchestrator = new ReActOrchestrator(llm, telemetry, {
      maxIterations: 3,
      planMode: "never",
      validateGoal: false,
      consoleThoughts: false,
      onIterationLimitReached: async (_task, iteration) => {
        limitReachedAt = iteration;
        return false;
      },
    });

    await orchestrator.run("test task");

    expect(limitReachedAt).toBe(3);
  });
});
