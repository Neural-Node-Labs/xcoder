/**
 * Live smoke test against the REAL DeepSeek API. Run this yourself, locally — your
 * DEEPSEEK_API_KEY never leaves your machine (it's read from your own .env / shell env and
 * sent only to https://api.deepseek.com, the same as any normal API call would do).
 *
 * Usage:
 *   cp .env.example .env   # fill in DEEPSEEK_API_KEY
 *   npm run build
 *   node dist/test/liveSmokeTest.js
 *
 * What this checks, for real:
 *  1. Basic completion works with the configured model (deepseek-v4-flash by default)
 *  2. Tool calling works: the model is given a trivial tool and asked to use it
 *  3. The full orchestrator loop works end-to-end against the live API, including the
 *     goal validator (a second real API call auditing the first's claimed completion)
 */
import "dotenv/config";
import { loadLlmConfig } from "../config/loadConfig.js";
import { DeepSeekClient } from "../llm/deepseekClient.js";
import { FileTelemetry } from "../telemetry/logger.js";
import { ReActOrchestrator } from "../core/orchestrator.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("DEEPSEEK_API_KEY not set. Copy .env.example to .env and fill it in first.");
    process.exit(1);
  }

  const config = loadLlmConfig();
  const telemetry = new FileTelemetry(os.tmpdir());
  const llm = new DeepSeekClient(config, telemetry);

  console.log(`Using model: ${config.model}\n`);

  // --- 1. Basic completion ---
  console.log("[1/3] Basic completion...");
  const basic = await llm.complete([{ role: "user", content: "Reply with exactly: OK" }]);
  console.log("  response:", basic.content.trim());
  console.log(basic.content.includes("OK") ? "  PASS\n" : "  UNEXPECTED (model didn't say OK, check manually)\n");

  // --- 2. Tool calling ---
  console.log("[2/3] Tool calling...");
  const toolResponse = await llm.complete(
    [{ role: "user", content: "What's the weather in Paris? Use the get_weather tool." }],
    {
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the weather for a location",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
              required: ["location"],
            },
          },
        },
      ],
    }
  );
  console.log("  tool_calls:", JSON.stringify(toolResponse.toolCalls));
  console.log(toolResponse.toolCalls.length > 0 ? "  PASS\n" : "  FAIL: model did not call the tool\n");

  // --- 3. Full orchestrator loop, live, including the goal validator ---
  console.log("[3/3] Full ReAct loop with real tool dispatch + goal validator...");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-live-"));
  fs.writeFileSync(path.join(cwd, "buggy.js"), "function add(a,b){ return a+b+1; }\nconsole.log(add(2,3));\n");

  const orchestrator = new ReActOrchestrator(llm, telemetry, { cwd, maxIterations: 6, planMode: "never" });
  const result = await orchestrator.run(
    "There's an off-by-one bug in buggy.js (add(2,3) should be 5, not 6). Find it, fix it, and verify by running the file."
  );
  console.log("\n  final result:", result);
  console.log("  buggy.js after run:", fs.readFileSync(path.join(cwd, "buggy.js"), "utf-8").trim());
  console.log(`  full trace: ${cwd}/.log/thinking.log`);

  console.log("\nDone. Inspect the trace above/in thinking.log to confirm the fix and validator behavior look right.");
}

main().catch((err) => {
  console.error("LIVE SMOKE TEST FAILED:", err);
  process.exit(1);
});


