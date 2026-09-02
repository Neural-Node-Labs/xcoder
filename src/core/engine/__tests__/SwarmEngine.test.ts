import { describe, it, expect, vi, beforeEach } from "vitest";
import { SwarmEngine, SwarmEngineOptions, WbsTask } from "../SwarmEngine.js";
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

// ─── WBS plan helpers ─────────────────────────────────────────────────────────────

const SINGLE_TASK_WBS =
  "| ID | Description | Dependencies | Instructions |\n" +
  "| T1 | Test task | None | Do something |";

const MULTI_TASK_WBS =
  "| ID | Description | Dependencies | Instructions |\n" +
  "| T1 | Task one | None | Do first thing |\n" +
  "| T2 | Task two | T1 | Do second thing |\n" +
  "| T3 | Task three | T1 | Do third thing |";

const CIRCULAR_DEP_WBS =
  "| ID | Description | Dependencies | Instructions |\n" +
  "| T1 | Task one | T2 | Depends on T2 |\n" +
  "| T2 | Task two | T1 | Depends on T1 |";

const SELF_DEP_WBS =
  "| ID | Description | Dependencies | Instructions |\n" +
  "| T1 | Task one | T1 | Self-referential |";

// ─── Tests ────────────────────────────────────────────────────────────────────────

describe("SwarmEngine", () => {
  let llm: LlmClient;
  let telemetry: TelemetryInterface;

  beforeEach(() => {
    llm = createMockLlm();
    telemetry = createMockTelemetry();
  });

  // ── Construction & defaults ────────────────────────────────────────────────────

  describe("construction", () => {
    it("creates an engine with default options", () => {
      const engine = new SwarmEngine(llm, telemetry);
      expect(engine).toBeInstanceOf(SwarmEngine);
      expect(engine.getState()).toEqual({ phase: "idle" });
    });

    it("creates an engine with custom options", () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 5,
        cwd: "/tmp/test",
        validateGoal: false,
        selfHealing: false,
        consoleThoughts: false,
        maxParallelAgents: 3,
        swarmAgentMaxIterations: 10,
        persistArtifacts: false,
        agentTimeoutMs: 60000,
      });
      expect(engine).toBeInstanceOf(SwarmEngine);
    });

    it("uses process.cwd() when no cwd option provided", () => {
      const engine = new SwarmEngine(llm, telemetry);
      expect(engine.getWorkspacePath()).toBe(process.cwd());
    });

    it("uses provided cwd option", () => {
      const engine = new SwarmEngine(llm, telemetry, { cwd: "/custom/path" });
      expect(engine.getWorkspacePath()).toBe("/custom/path");
    });
  });

  // ── Input Validation ───────────────────────────────────────────────────────────

  describe("input validation", () => {
    it("throws on empty task description", async () => {
      const engine = new SwarmEngine(llm, telemetry, { validateGoal: false });
      await expect(engine.run("")).rejects.toThrow(
        "SwarmEngine.run() requires a non-empty taskDescription string."
      );
    });

    it("throws on whitespace-only task description", async () => {
      const engine = new SwarmEngine(llm, telemetry, { validateGoal: false });
      await expect(engine.run("   ")).rejects.toThrow(
        "SwarmEngine.run() requires a non-empty taskDescription string."
      );
    });

    it("throws on non-string task description", async () => {
      const engine = new SwarmEngine(llm, telemetry, { validateGoal: false });
      await expect(engine.run(null as unknown as string)).rejects.toThrow(
        "SwarmEngine.run() requires a non-empty taskDescription string."
      );
    });

    it("throws on undefined task description", async () => {
      const engine = new SwarmEngine(llm, telemetry, { validateGoal: false });
      await expect(engine.run(undefined as unknown as string)).rejects.toThrow(
        "SwarmEngine.run() requires a non-empty taskDescription string."
      );
    });
  });

  // ── IReactEngineV2 lifecycle ───────────────────────────────────────────────────

  describe("lifecycle (IReactEngineV2)", () => {
    it("starts in idle state", () => {
      const engine = new SwarmEngine(llm, telemetry);
      expect(engine.getState()).toEqual({ phase: "idle" });
    });

    it("transitions to running during execution", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });
      const states: EngineState[] = [];
      engine.onProgress((s) => states.push(s));

      const result = await engine.run("test task");

      expect(result).toBe("Task completed successfully.");
      const runningStates = states.filter((s) => s.phase === "running");
      expect(runningStates.length).toBeGreaterThanOrEqual(1);
      const completedState = states.find((s) => s.phase === "completed");
      expect(completedState).toBeDefined();
      if (completedState && completedState.phase === "completed") {
        expect(completedState.outcome).toBe("completed");
      }
    });


    it("cancel is idempotent when already idle", () => {
      const engine = new SwarmEngine(llm, telemetry);
      engine.cancel("already idle");
      expect(engine.getState()).toEqual({ phase: "idle" });
    });

    it("cancel is idempotent when already completed", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });
      await engine.run("test task");
      engine.cancel("after completion");
      // State should remain completed, not cancelled
      const state = engine.getState();
      expect(state.phase).toBe("completed");
    });

    it("supports progress observers", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });
      const observer = vi.fn();
      const unsubscribe = engine.onProgress(observer);

      await engine.run("test task");

      expect(observer).toHaveBeenCalled();
      const completedCalls = observer.mock.calls.filter(
        (c) => c[0].phase === "completed"
      );
      expect(completedCalls.length).toBe(1);

      unsubscribe();
      observer.mockClear();
    });

    it("observer errors do not crash the engine", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });
      engine.onProgress(() => {
        throw new Error("observer error");
      });

      const result = await engine.run("test task");
      expect(result).toBe("Task completed successfully.");
    });

    it("multiple observers all receive notifications", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });
      const observer1 = vi.fn();
      const observer2 = vi.fn();
      engine.onProgress(observer1);
      engine.onProgress(observer2);

      await engine.run("test task");

      expect(observer1).toHaveBeenCalled();
      expect(observer2).toHaveBeenCalled();
    });

    it("unsubscribed observer stops receiving notifications", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });
      const observer = vi.fn();
      const unsubscribe = engine.onProgress(observer);
      unsubscribe();

      await engine.run("test task");

      expect(observer).not.toHaveBeenCalled();
    });

    it("getLastMessages returns message history after run", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });
      await engine.run("test task");

      const messages = engine.getLastMessages();
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages[0].role).toBe("system");
      expect(messages[1].role).toBe("user");
    });

    it("getLastMessages returns empty array before any run", () => {
      const engine = new SwarmEngine(llm, telemetry);
      expect(engine.getLastMessages()).toEqual([]);
    });

    it("getIterationCount returns 0 before any run", () => {
      const engine = new SwarmEngine(llm, telemetry);
      expect(engine.getIterationCount()).toBe(0);
    });

    it("getIterationCount returns iteration count after run", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });
      await engine.run("test task");
      expect(engine.getIterationCount()).toBe(1);
    });
  });

  // ── IReactEngine interface ─────────────────────────────────────────────────────

  describe("IReactEngine interface", () => {
    it("getLastOutcome returns 'completed' after successful run", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });
      await engine.run("test task");
      expect(engine.getLastOutcome()).toBe("completed");
    });

    it("getCumulativeUsage returns usage data", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });
      await engine.run("test task");
      const usage = engine.getCumulativeUsage();
      expect(usage.totalTokens).toBeGreaterThan(0);
      expect(usage.promptTokens).toBeGreaterThan(0);
    });

    it("getCumulativeUsage returns a copy, not the internal object", () => {
      const engine = new SwarmEngine(llm, telemetry);
      const usage1 = engine.getCumulativeUsage();
      const usage2 = engine.getCumulativeUsage();
      usage1.totalTokens = 999;
      expect(usage2.totalTokens).not.toBe(999);
    });

    it("getHealthScore returns 100 when no steps scored", () => {
      const engine = new SwarmEngine(llm, telemetry);
      expect(engine.getHealthScore()).toBe(100);
    });

    it("getPartialSuccess returns undefined when no partial success", () => {
      const engine = new SwarmEngine(llm, telemetry);
      expect(engine.getPartialSuccess()).toBeUndefined();
    });

    it("getSubagentLimitContext returns undefined when no subagent limit", () => {
      const engine = new SwarmEngine(llm, telemetry);
      expect(engine.getSubagentLimitContext()).toBeUndefined();
    });

    it("selectSkills returns empty array for unknown task", () => {
      const engine = new SwarmEngine(llm, telemetry);
      const skills = engine.selectSkills("some random task with no matching skill");
      expect(skills).toEqual([]);
    });

    it("generatePlan returns a plan string", async () => {
      const engine = new SwarmEngine(llm, telemetry);
      const plan = await engine.generatePlan("test task");
      expect(plan).toContain("Swarm Plan");
      expect(plan).toContain("test task");
    });
  });

  // ── WBS Parsing & Validation ───────────────────────────────────────────────────

  describe("WBS parsing and validation", () => {
    it("falls back to single-agent mode when WBS has no tasks", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });

      // Mock generateWbs to return an empty WBS
      (engine as any).generateWbs = vi.fn(async () => "");

      const result = await engine.run("test task");
      expect(result).toBe("Task completed successfully.");
    });

    it("falls back to single-agent mode when WBS has only header", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });

      // Mock generateWbs to return a header-only WBS
      (engine as any).generateWbs = vi.fn(
        async () => "| ID | Description | Dependencies | Instructions |"
      );

      const result = await engine.run("test task");
      expect(result).toBe("Task completed successfully.");
    });

    it("falls back to single-agent mode on circular dependencies", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });

      // Mock generateWbs to return a WBS with circular deps
      (engine as any).generateWbs = vi.fn(async () => CIRCULAR_DEP_WBS);

      const result = await engine.run("test task");
      expect(result).toBe("Task completed successfully.");
    });

    it("falls back to single-agent mode on self-referential dependencies", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });

      (engine as any).generateWbs = vi.fn(async () => SELF_DEP_WBS);

      const result = await engine.run("test task");
      expect(result).toBe("Task completed successfully.");
    });

    it("parses multi-task WBS correctly", async () => {
      const engine = new SwarmEngine(llm, telemetry, {
        maxIterations: 1,
        validateGoal: false,
        persistArtifacts: false,
      });

      const tasks = (engine as any).parseWbsTasks(MULTI_TASK_WBS);
      expect(tasks.length).toBe(3);
      expect(tasks[0]).toMatchObject({ id: "T1", description: "Task one", dependencies: [], status: "pending" });
      expect(tasks[1]).toMatchObject({ id: "T2", description: "Task two", dependencies: ["T1"] });
      expect(tasks[2]).toMatchObject({ id: "T3", description: "Task three", dependencies: ["T1"] });
    });

    it("returns an empty array when parsing an empty WBS plan", () => {
      const engine = new SwarmEngine(llm, telemetry);
      expect((engine as any).parseWbsTasks("")).toEqual([]);
    });

    it("returns an empty array when parsing a header-only WBS plan", () => {
      const engine = new SwarmEngine(llm, telemetry);
      const tasks = (engine as any).parseWbsTasks("| ID | Description | Dependencies | Instructions |");
      expect(tasks).toEqual([]);
    });

    it("detects no circular dependencies in a valid DAG", () => {
      const engine = new SwarmEngine(llm, telemetry);
      (engine as any).wbsTasks = (engine as any).parseWbsTasks(MULTI_TASK_WBS);
      expect((engine as any).validateWbsDependencies()).toEqual([]);
    });

    it("detects circular dependencies", () => {
      const engine = new SwarmEngine(llm, telemetry);
      (engine as any).wbsTasks = (engine as any).parseWbsTasks(CIRCULAR_DEP_WBS);
      const errors = (engine as any).validateWbsDependencies();
      expect(errors.length).toBeGreaterThan(0);
    });

    it("detects self-referential dependencies", () => {
      const engine = new SwarmEngine(llm, telemetry);
      (engine as any).wbsTasks = (engine as any).parseWbsTasks(SELF_DEP_WBS);
      const errors = (engine as any).validateWbsDependencies();
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});

