import { runLiveDiagnostics } from "../core/liveDiagnostics.js";
import { LlmMessage, LlmResponse, ToolCall } from "../core/types.js";
import assert from "node:assert/strict";

function tc(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

const DOCKERFILE = `FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n`;

// Deliberately broken: never actually listens on process.env.PORT, so /health can never respond.
const BROKEN_SERVER = `const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); }
}).listen(9999); // ignores process.env.PORT -- broken on purpose
`;

/**
 * Mixed mock: well-behaved for diagnostics 1, 2, 4, 6, 7 (reuses the same scripts proven to
 * pass in testLiveDiagnosticsHarness.ts), but deliberately bad for diagnostics 3 and 5:
 *  - #3: repeats the exact same command with zero new information, a genuine wasteful duplicate
 *  - #5: ships a server that never binds to the requested port -- genuinely broken, not lucky
 */
class MixedGoodAndBadMock {
  private stepCounters = new Map<string, number>();

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    if (messages[0]?.content.includes("independent verification agent")) {
      return { content: JSON.stringify({ valid: true, reason: "harness validator: always accept" }), toolCalls: [] };
    }
    const task = messages[1]?.content ?? "";
    const step = this.stepCounters.get(task) ?? 0;
    this.stepCounters.set(task, step + 1);

    if (task.includes("check.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node check.js" })] },
        { content: "task_complete: printed ready.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    if (task.includes("steps.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "steps.js" })] },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node steps.js" })] },
        { content: "", toolCalls: [tc("c2", "run_command_tool", { command: "echo done" })] },
        { content: "task_complete: all outputs reported.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    // #3: BAD -- calls the exact same command twice with no reason, identical observation both times.
    if (task.includes("flaky.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node flaky.js" })] },
        { content: "", toolCalls: [tc("c2", "run_command_tool", { command: "node flaky.js" })] }, // wasteful repeat
        { content: "task_complete: confirmed output is 4.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    if (task.includes("Write a Dockerfile for a minimal Node.js app")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "write", filePath: "Dockerfile", content: DOCKERFILE })] },
        { content: "task_complete: Dockerfile written.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    // #5: BAD -- ships a server that never binds to the correct port, so it's genuinely non-functional.
    if (task.includes("Build a minimal, deployable Node.js HTTP server")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "write", filePath: "server.js", content: BROKEN_SERVER })] },
        { content: "", toolCalls: [tc("w2", "write_edit_tool", { mode: "write", filePath: "Dockerfile", content: DOCKERFILE })] },
        { content: "task_complete: server.js and Dockerfile are in place.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    // Bug-fixing (#6) and full SDLC (#7) aren't the focus of this negative test -- keep them
    // failing fast/neutral rather than spending effort scripting them out; the point here is
    // isolating that #3 and #5 specifically catch their respective injected problems.
    return { content: "task_complete: skipping detailed work for this diagnostic (not under test here).", toolCalls: [] };
  }
}

async function main() {
  console.log("Running live-diagnostics harness with a mock that's deliberately bad at #3 and #5...\n");
  const report = await runLiveDiagnostics(new MixedGoodAndBadMock(), "harness-mixed-mock");
  console.log(report.markdown);

  const d1 = report.results.find((r) => r.id === "1")!;
  const d2 = report.results.find((r) => r.id === "2")!;
  const d3 = report.results.find((r) => r.id === "3")!;
  const d5 = report.results.find((r) => r.id === "5")!;

  assert.equal(d1.passed, true, "diagnostic 1 (well-behaved) should still pass");
  assert.equal(d2.passed, true, "diagnostic 2 (well-behaved) should still pass");
  assert.equal(d3.passed, false, "diagnostic 3 should FAIL: the mock made a genuinely wasteful exact-duplicate call");
  assert.ok(d3.evidence.some((e) => e.includes("node flaky.js")), "diagnostic 3's evidence should name the specific duplicated call");
  assert.equal(d5.passed, false, "diagnostic 5 should FAIL: the mock shipped a server that never binds to the correct port");
  assert.ok(d5.evidence.some((e) => e.includes("up=false")), "diagnostic 5's evidence should show the independent health check genuinely failed");

  console.log("PASS: diagnostics 3 and 5 correctly FAIL on genuinely bad behavior, while 1 and 2 correctly still PASS on well-behaved parts of the same run.");
}

main().catch((err) => {
  console.error("NEGATIVE TEST FAILED:", err);
  process.exit(1);
});


