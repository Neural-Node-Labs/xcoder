// ronin:version 4 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:46:09.085Z | ronin:subtask code-st-f034f3
import { describe, it, expect, vi } from "vitest";
import { createEngine, DEFAULT_ENGINE, EngineDeps, listEngines } from "../EngineRegistry.js";
import { IReactEngineV2 } from "../IReactEngine.js";
import { LlmClient, LlmResponse, TelemetryInterface } from "../../types.js";

it("DEFAULT_ENGINE is 'sdlc' and react plus the original four engines remain registered", () => {
  expect(DEFAULT_ENGINE).toBe("sdlc");
  const engines = listEngines();
  for (const name of ["react", "lean", "simple", "swarm", "sdlc"]) {
    expect(engines).toContain(name);
  }
  // LangGraphEngine was removed (langgraph dependency dropped) — it must not linger in the registry.
  expect(engines).not.toContain("langgraph");
});

it("agentic, brain, procedure, and sdlc are registered and creatable as IReactEngine objects", async () => {
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
  const deps: EngineDeps = { llm, telemetry, options: { cwd: process.cwd() } };

  const engines = listEngines();
  for (const name of ["agentic", "brain", "procedure", "sdlc"]) {
    expect(engines).toContain(name);
    const engine = createEngine(name, deps);
    expect(typeof engine.run).toBe("function");
    expect(typeof engine.generatePlan).toBe("function");
    expect(typeof engine.selectSkills).toBe("function");
    expect(typeof engine.getLastOutcome).toBe("function");
    expect(typeof engine.getCumulativeUsage).toBe("function");
    expect(typeof engine.getHealthScore).toBe("function");
    expect(typeof engine.getPartialSuccess).toBe("function");
    expect(typeof engine.getSubagentLimitContext).toBe("function");
    const v2 = engine as unknown as IReactEngineV2;
    expect(v2.getWorkspacePath()).toBe(process.cwd());
  }
});

it("unknown engine names still throw with the known list", () => {
  const llm: LlmClient = {
    complete: vi.fn(async (): Promise<LlmResponse> => ({
      content: "",
      toolCalls: [],
      reasoningContent: undefined,
      usage: undefined,
    })),
  };
  const telemetry: TelemetryInterface = {
    logThought: vi.fn(async () => {}),
    logLlmCall: vi.fn(async () => {}),
    logError: vi.fn(async () => {}),
  };
  expect(() => createEngine("does-not-exist", { llm, telemetry })).toThrow(/does-not-exist/);
});
