import { DeepSeekClient } from "../llm/deepseekClient.js";
import { LlmConfig } from "../config/loadConfig.js";
import assert from "node:assert/strict";

const baseConfig: LlmConfig = {
  provider: "deepseek",
  base_url: "https://api.deepseek.com/v1",
  endpoint: "/chat/completions",
  model: "deepseek-v4-flash",
  api_key_env: "DEEPSEEK_TEST_KEY",
  max_tokens: 4096,
  temperature: 0.0,
  thinking: false,
  overrides: {
    rca: { model: "deepseek-v4-pro", thinking: true, reasoning_effort: "high" },
  },
};

process.env.DEEPSEEK_TEST_KEY = "fake-key-for-body-inspection-only";

let capturedBody: any = null;
const originalFetch = globalThis.fetch;

function stubFetch(responseBody: any) {
  globalThis.fetch = (async (_url: string, init: any) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    } as Response;
  }) as typeof fetch;
}

const fakeApiResponse = { choices: [{ message: { content: "hi", tool_calls: [] } }] };

async function testNonThinkingModeSendsTemperatureAndExplicitDisabled() {
  stubFetch(fakeApiResponse);
  const client = new DeepSeekClient(baseConfig, undefined);
  await client.complete([{ role: "user", content: "hello" }]);

  assert.equal(capturedBody.thinking.type, "disabled", "non-thinking mode must explicitly send thinking:disabled, never omit it");
  assert.equal(capturedBody.temperature, 0.0, "non-thinking mode should send temperature");
  assert.equal(capturedBody.reasoning_effort, undefined, "reasoning_effort should not be sent outside thinking mode");
  console.log("PASS: non-thinking mode explicitly sends thinking:disabled, includes temperature, omits reasoning_effort");
}

async function testThinkingModeOmitsTemperatureAndSendsReasoningEffort() {
  stubFetch(fakeApiResponse);
  const client = new DeepSeekClient(baseConfig, undefined, "rca"); // triggers the rca override: thinking + reasoning_effort
  await client.complete([{ role: "user", content: "investigate this incident" }]);

  assert.equal(capturedBody.thinking.type, "enabled", "rca skill override should enable thinking");
  assert.equal(capturedBody.model, "deepseek-v4-pro", "rca skill override should switch model");
  assert.equal(capturedBody.reasoning_effort, "high", "rca skill override should set reasoning_effort");
  assert.equal("temperature" in capturedBody, false, "thinking mode must OMIT temperature entirely -- DeepSeek's docs say it has no effect, sending it is dead weight");
  assert.equal("top_p" in capturedBody, false, "thinking mode must OMIT top_p entirely");
  console.log("PASS: thinking mode (rca override) omits temperature/top_p, sends reasoning_effort:high, switches model");
}

async function testResponseFormatPassthroughForJsonMode() {
  stubFetch(fakeApiResponse);
  const client = new DeepSeekClient(baseConfig, undefined);
  await client.complete([{ role: "user", content: "respond in json" }], { responseFormat: "json_object" });

  assert.deepEqual(capturedBody.response_format, { type: "json_object" }, "responseFormat option should map to DeepSeek's response_format: {type: 'json_object'}");
  console.log("PASS: response_format json_object is correctly passed through (used by the goal validator)");
}

async function testReasoningContentIsPreservedAcrossMessages() {
  stubFetch(fakeApiResponse);
  const client = new DeepSeekClient(baseConfig, undefined);
  await client.complete([
    { role: "user", content: "task" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }], reasoning_content: "my prior reasoning" },
    { role: "tool", tool_call_id: "c1", name: "x", content: "{}" },
  ]);

  const assistantMsgInBody = capturedBody.messages.find((m: any) => m.role === "assistant");
  assert.equal(assistantMsgInBody.reasoning_content, "my prior reasoning", "reasoning_content on a prior assistant message must be preserved in the outgoing request, required for thinking-mode multi-turn tool calling per DeepSeek's docs");
  console.log("PASS: reasoning_content on prior assistant messages is preserved in the outgoing request body");
}

async function main() {
  await testNonThinkingModeSendsTemperatureAndExplicitDisabled();
  await testThinkingModeOmitsTemperatureAndSendsReasoningEffort();
  await testResponseFormatPassthroughForJsonMode();
  await testReasoningContentIsPreservedAcrossMessages();
  globalThis.fetch = originalFetch;
  console.log("\n4/4 DeepSeek request-body contract tests passed.");
}

main().catch((err) => {
  globalThis.fetch = originalFetch;
  console.error("TEST FAILED:", err);
  process.exit(1);
});


