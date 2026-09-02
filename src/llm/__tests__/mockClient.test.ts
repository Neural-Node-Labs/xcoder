import { describe, it, expect, vi } from "vitest";
import { AutoMockLlmClient } from "../mockClient.js";
import { validateGoal } from "../../core/goalValidator.js";
import { LeanEngine } from "../../core/engine/LeanEngine.js";
import { createLlmClient } from "../deepseekClient.js";
import type { TelemetryInterface } from "../../core/types.js";

function makeTelemetry(): TelemetryInterface {
  return {
    logThought: vi.fn(async () => {}),
    logLlmCall: vi.fn(async () => {}),
    logError: vi.fn(async () => {}),
  };
}

describe("AutoMockLlmClient — direct behavior", () => {
  it("answers a plain (non-JSON) completion with no tool calls and a [MOCK]-prefixed content", async () => {
    const client = new AutoMockLlmClient();
    const res = await client.complete([{ role: "user", content: "add input validation to the signup form" }]);

    expect(res.toolCalls).toEqual([]);
    expect(res.content).toContain("[MOCK]");
    expect(res.content).toContain("add input validation to the signup form");
    expect(res.finishReason).toBe("stop");
  });

  it("returns plausible, non-zero token usage on every call", async () => {
    const client = new AutoMockLlmClient();
    const res = await client.complete([{ role: "user", content: "task" }]);
    expect(res.usage).toBeDefined();
    expect(res.usage!.promptTokens).toBeGreaterThan(0);
    expect(res.usage!.completionTokens).toBeGreaterThan(0);
    expect(res.usage!.totalTokens).toBeGreaterThan(0);
  });

  it("answers a responseFormat: json_object request with valid, parseable JSON containing every field current callers read", async () => {
    const client = new AutoMockLlmClient();
    const res = await client.complete([{ role: "user", content: "grade this" }], { responseFormat: "json_object" });

    const parsed = JSON.parse(res.content);
    // goalValidator.ts's shape
    expect(typeof parsed.valid).toBe("boolean");
    expect(typeof parsed.reason).toBe("string");
    // AgenticEngine's think-step shape
    expect(typeof parsed.phase).toBe("string");
    expect(typeof parsed.thought).toBe("string");
    expect(typeof parsed.tool).toBe("string");
    expect(typeof parsed.done).toBe("boolean");
    expect(typeof parsed.final_answer).toBe("string");
  });

  it("works for many calls in a row without needing any scripting (unlike MockLlmClient)", async () => {
    const client = new AutoMockLlmClient();
    for (let i = 0; i < 10; i++) {
      const res = await client.complete([{ role: "user", content: `task ${i}` }]);
      expect(res.content).toContain("[MOCK]");
    }
    expect(client.seenMessages).toHaveLength(10);
  });

  it("truncates a very long user message excerpt to ~160 chars with an ellipsis, rather than echoing it in full", async () => {
    const client = new AutoMockLlmClient();
    const longTask = "x".repeat(500);
    const res = await client.complete([{ role: "user", content: longTask }]);
    expect(res.content).toContain("x".repeat(160));
    expect(res.content).not.toContain("x".repeat(200)); // the full 500-char run should never appear intact
    expect(res.content).toContain("…");
  });
});

describe("AutoMockLlmClient — real integration with validateGoal (the Validation Gate)", () => {
  it("validateGoal() successfully parses AutoMockLlmClient's JSON response and reports a pass", async () => {
    const client = new AutoMockLlmClient();
    const verdict = await validateGoal(client, "do the task", "[read_tool] read file.ts", "done");
    expect(verdict.valid).toBe(true);
    expect(verdict.reason).toContain("mock");
  });
});

describe("AutoMockLlmClient — real integration with LeanEngine (a full ReAct loop)", () => {
  it("drives a real LeanEngine.run() to completion with no real network access, in one iteration", async () => {
    const client = new AutoMockLlmClient();
    const telemetry = makeTelemetry();
    const engine = new LeanEngine(client, telemetry, { cwd: "/tmp", maxIterations: 5, validateGoal: false, consoleThoughts: false });

    const result = await engine.run("add a health check endpoint");

    expect(result).toContain("[MOCK]");
    expect(engine.getIterationCount()).toBeGreaterThanOrEqual(1);
    expect(engine.getIterationCount()).toBeLessThanOrEqual(2); // should terminate almost immediately — no tool calls to chase
    expect(engine.getCumulativeUsage().totalTokens).toBeGreaterThan(0);
  });

  it("generatePlan() also works against the mock — no real LLM needed for plan mode either", async () => {
    const client = new AutoMockLlmClient();
    const telemetry = makeTelemetry();
    const engine = new LeanEngine(client, telemetry, { cwd: "/tmp" });
    const plan = await engine.generatePlan("build a REST API");
    expect(plan).toContain("[MOCK]");
  });
});

describe("createLlmClient() factory — the centralized mock/real construction seam", () => {
  const config = {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    api_key_env: "DEEPSEEK_API_KEY",
    max_tokens: 4096,
    temperature: 0,
  };

  it("returns an AutoMockLlmClient when opts.mock is true, regardless of config.provider", async () => {
    const client = createLlmClient(config, undefined, undefined, { mock: true });
    expect(client).toBeInstanceOf(AutoMockLlmClient);
  });

  it("returns a real DeepSeekClient when opts.mock is false/omitted", async () => {
    delete process.env.XCODER_MOCK_LLM;
    const client = createLlmClient(config, undefined, undefined, { mock: false });
    expect(client).not.toBeInstanceOf(AutoMockLlmClient);
  });

  it("falls back to the XCODER_MOCK_LLM env var when opts.mock is not explicitly given", async () => {
    process.env.XCODER_MOCK_LLM = "1";
    try {
      const client = createLlmClient(config);
      expect(client).toBeInstanceOf(AutoMockLlmClient);
    } finally {
      delete process.env.XCODER_MOCK_LLM;
    }
  });

  it("XCODER_MOCK_LLM='true' (not just '1') also activates mock mode", async () => {
    process.env.XCODER_MOCK_LLM = "true";
    try {
      const client = createLlmClient(config);
      expect(client).toBeInstanceOf(AutoMockLlmClient);
    } finally {
      delete process.env.XCODER_MOCK_LLM;
    }
  });

  it("an explicit opts.mock: false overrides a truthy XCODER_MOCK_LLM env var", async () => {
    process.env.XCODER_MOCK_LLM = "1";
    try {
      const client = createLlmClient(config, undefined, undefined, { mock: false });
      expect(client).not.toBeInstanceOf(AutoMockLlmClient);
    } finally {
      delete process.env.XCODER_MOCK_LLM;
    }
  });
});
