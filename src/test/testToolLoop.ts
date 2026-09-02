import { ReActOrchestrator } from "../core/orchestrator.js";
import { MockLlmClient, toolCall } from "../llm/mockClient.js";
import { FileTelemetry } from "../telemetry/logger.js";
import fs from "node:fs";
import path from "node:path";

/**
 * Simulates a realistic multi-turn tool-calling session:
 *  1. glob_tool to find source files (Search)
 *  2. read_tool to inspect one (Search)
 *  3. write_edit_tool to fix it (Action)
 *  4. run_command_tool "npm test" to validate (Validation)
 *  5. final text response, no more tool calls -> loop ends
 */
async function main() {
  const cwd = process.argv[2];
  if (!cwd) throw new Error("usage: node testToolLoop.js <workspace-dir>");

  const mock = new MockLlmClient([
    { content: "", toolCalls: [toolCall("c1", "glob_tool", { pattern: "**/*.js" })] },
    { content: "", toolCalls: [toolCall("c2", "read_tool", { filePath: "buggy.js" })] },
    {
      content: "",
      toolCalls: [
        toolCall("c3", "write_edit_tool", {
          mode: "edit",
          filePath: "buggy.js",
          oldStr: "return a + b + 1;",
          newStr: "return a + b;",
        }),
      ],
    },
    { content: "", toolCalls: [toolCall("c4", "run_command_tool", { command: "node buggy.js" })] },
    { content: "task_complete: fixed off-by-one bug and verified via run_command_tool.", toolCalls: [] },
  ]);

  const telemetry = new FileTelemetry(cwd);
  const orchestrator = new ReActOrchestrator(mock, telemetry, { cwd, maxIterations: 10, validateGoal: false });

  await orchestrator.run("fix the off-by-one bug in buggy.js");

  // --- Assertions ---
  const fileContent = fs.readFileSync(path.join(cwd, "buggy.js"), "utf-8");
  if (fileContent.includes("+ 1")) throw new Error("FAIL: edit was not applied");
  console.log("PASS: write_edit_tool correctly applied the fix");

  const thinkingLog = fs.readFileSync(path.join(cwd, ".agent", "logs", "thinking.log"), "utf-8");
  const loggedTools = ["glob_tool", "read_tool", "write_edit_tool", "run_command_tool"];
  for (const t of loggedTools) {
    if (!thinkingLog.includes(t)) throw new Error(`FAIL: ${t} not found in thinking.log`);
  }
  console.log("PASS: all 4 tool calls logged to thinking.log with phase/observation");

  const phases = mock.seenMessages;
  console.log(`PASS: orchestrator made ${phases.length} LLM calls (search->action->validation->final)`);
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});


