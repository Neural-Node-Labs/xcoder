// ronin:version 1 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:44:00.048Z | ronin:subtask code-st-f034f3
import { describe, it, expect, vi } from "vitest";
import { MultiRoleRouter, LLMRouterError } from "../router.js";
import { LlmClient, LlmMessage, LlmResponse } from "../../types.js";

function makeLlm(): LlmClient {
  return {
    complete: vi.fn(async (messages: LlmMessage[]): Promise<LlmResponse> => ({
      content: `echo: ${messages.map((m) => m.content).join(" | ")}`,
      toolCalls: [],
      reasoningContent: undefined,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })),
  };
}

describe("MultiRoleRouter", () => {
  it("requires at least one role", () => {
    expect(() => new MultiRoleRouter(makeLlm(), {})).toThrow(LLMRouterError);
  });

  it("lists and detects roles", () => {
    const router = new MultiRoleRouter(makeLlm(), { orchestrator: { model: "m1" }, critic: {} });
    expect(router.roleNames.sort()).toEqual(["critic", "orchestrator"].sort());
    expect(router.hasRole("critic")).toBe(true);
    expect(router.hasRole("nope")).toBe(false);
  });

  it("adds and replaces roles after construction", () => {
    const router = new MultiRoleRouter(makeLlm(), { orchestrator: {} });
    router.addRole("executor", { model: "small" });
    expect(router.hasRole("executor")).toBe(true);
    expect(router.configForRole("executor").model).toBe("small");
  });

  it("throws LLMRouterError for unknown roles", () => {
    const router = new MultiRoleRouter(makeLlm(), { orchestrator: {} });
    expect(() => router.configForRole("ghost")).toThrow(/Unknown role 'ghost'/);
  });

  it("routes the call through the injected LlmClient with resolved model/temperature/format", async () => {
    const llm = makeLlm();
    const router = new MultiRoleRouter(llm, {
      orchestrator: { model: "default-model", temperature: 0.7 },
    });

    const reply = await router.chat({
      messages: [{ role: "user", content: "hi" }],
      role: "orchestrator",
      model: "explicit-model",
      responseFormat: "json_object",
    });

    expect(reply).toContain("echo: hi");
    expect(llm.complete).toHaveBeenCalledWith(
      [{ role: "user", content: "hi" }],
      expect.objectContaining({
        model: "explicit-model",
        temperature: 0.7,
        responseFormat: "json_object",
      })
    );
  });

  it("defaults temperature to 0.2 and passes model undefined for unset roles", async () => {
    const llm = makeLlm();
    const router = new MultiRoleRouter(llm, { orchestrator: {} });
    await router.chat({ messages: [{ role: "user", content: "x" }], role: "orchestrator" });
    expect(llm.complete).toHaveBeenCalledWith(
      [{ role: "user", content: "x" }],
      expect.objectContaining({ model: undefined, temperature: 0.2, responseFormat: undefined })
    );
  });
});
