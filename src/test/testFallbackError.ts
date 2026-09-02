/**
 * Tests that the fallback error message surfaces the actual (primary) failure reason
 * first, rather than burying it behind "Fallback provider X missing Y".
 */
import { DeepSeekClient } from "../llm/deepseekClient.js";
import type { LlmConfig } from "../config/loadConfig.js";

const config: LlmConfig = {
  provider: "deepseek",
  base_url: "https://api.deepseek.com/v1",
  endpoint: "/chat/completions",
  model: "deepseek-v4-flash",
  api_key_env: "DEEPSEEK_TEST_KEY",
  max_tokens: 4096,
  temperature: 0.0,
  thinking: false,
  fallback: {
    provider: "anthropic",
    model: "claude-sonnet-5",
    api_key_env: "ANTHROPIC_TEST_KEY",
  },
};

async function main() {
  // Ensure both keys are absent
  delete process.env.DEEPSEEK_TEST_KEY;
  delete process.env.ANTHROPIC_TEST_KEY;

  const client = new DeepSeekClient(config, undefined);
  try {
    await client.complete([{ role: "user", content: "hello" }]);
    console.error("UNEXPECTED: should have thrown");
    process.exit(1);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("Error message:");
    console.log(msg);
    console.log("");

    // The actual error (primary failure) must come first
    if (msg.startsWith("Primary LLM call failed: missing DEEPSEEK_API_KEY.")) {
      console.log("PASS: Error message leads with the actual (primary) failure reason");
    } else {
      console.error("FAIL: Error message does not start with the primary failure reason");
      process.exit(1);
    }

    // The fallback info should still be present, but as secondary context
    if (msg.includes("Fallback provider anthropic also unavailable")) {
      console.log("PASS: Fallback info is still present as secondary context");
    } else {
      console.error("FAIL: Fallback info is missing from the error message");
      process.exit(1);
    }

    // The request payload should still be included for diagnostics
    if (msg.includes("Request payload:")) {
      console.log("PASS: Request payload is included for diagnostics");
    } else {
      console.error("FAIL: Request payload is missing from the error message");
      process.exit(1);
    }
  }

  console.log("\nAll fallback error message tests passed.");
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});


