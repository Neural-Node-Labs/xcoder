// ronin:version 1 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:43:45.412Z | ronin:subtask code-st-f034f3
import { describe, it, expect, vi } from "vitest";
import { BrainEngine } from "../BrainEngine.js";
import { LlmClient, LlmMessage, LlmResponse, TelemetryInterface } from "../../types.js";
import { EngineDeps } from "../EngineRegistry.js";

function makeUsage() {
  return { promptTokens: 5, completionTokens: 3, totalTokens: 8, reasoningTokens: 0, cachedTokens: 0 };
}

function makeDeps(overrides: Partial<EngineDeps> = {}): EngineDeps {
  const telemetry: TelemetryInterface = {
    logThought: vi.fn(async () => {}),
    logLlmCall: vi.fn(async () => {}),
    logError: vi.fn(async () => {}),
  };
  return { llm: makeLlm(), telemetry, options: { cwd: process.cwd() }, ...overrides };
}

/** Role-distinguished canned responses: prompts containing "critic role" get critic text. */
function makeLlm(): LlmClient {
  return {
    complete: vi.fn(async (messages: LlmMessage[]): Promise<LlmResponse> => {
      const userText = messages.map((m) => m.content).join("\n");
      const isCritic = userText.includes("critic role");
      return {
        content: isCritic
          ? "Looks correct; no blocking gaps found."
          : "Orchestrator plan: 1. search 2. validate 3. summarize",
        toolCalls: [],
        reasoningContent: undefined,
        usage: makeUsage(),
      };
    }),
  };
}

describe("BrainEngine", () => {
  describe("AC-6: >=2 roles with a scripted provider", () => {
    it("exposes at least 2 router roles", () => {
      const engine = new BrainEngine(makeDeps());
      const roleNames = engine.getRouter().roleNames;
      expect(roleNames.length).toBeGreaterThanOrEqual(2);
      expect(engine.getRouter().hasRole("orchestrator")).toBe(true);
      expect(engine.getRouter().hasRole("critic")).toBe(true);
    });

    it("routes a task through orchestrator then critic and synthesizes the answer", async () => {
      const deps = makeDeps();
      const engine = new BrainEngine(deps);

      const answer = await engine.run("implement the login endpoint");

      expect(answer).toContain("Orchestrator plan: 1. search 2. validate 3. summarize");
      expect(answer).toContain("Critic review:");
      expect(answer).toContain("no blocking gaps");
      expect(deps.llm.complete).toHaveBeenCalledTimes(2);
      expect(engine.getIterationCount()).toBe(2);
    });
  });

  describe("lifecycle surface", () => {
    it("generates a plan from the orchestrator role", async () => {
      const engine = new BrainEngine(makeDeps());
      const plan = await engine.generatePlan("design the schema");
      expect(plan).toContain("Orchestrator plan");
    });

    it("returns [] from selectSkills in v1", () => {
      const engine = new BrainEngine(makeDeps());
      expect(engine.selectSkills("anything")).toEqual([]);
    });
  });
});
