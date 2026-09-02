import { ReActOrchestrator } from "../core/orchestrator.js";
import { toolCall } from "../llm/mockClient.js";
import { FileTelemetry } from "../telemetry/logger.js";
import { LlmMessage, LlmResponse } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const cwdBase = process.argv[2];
if (!cwdBase) throw new Error("usage: node testGoalValidator.js <workspace-dir>");

let passCount = 0;
function pass(msg: string) {
  passCount += 1;
  console.log(`PASS: ${msg}`);
}

/**
 * A mock that plays TWO roles depending on which system prompt it's asked with:
 *  - the "worker" (main ReAct loop): follows a scripted sequence
 *  - the "validator" (goal_validator's independent audit call): applies a real skepticism
 *    rule against the observation transcript it's given, rather than a scripted answer —
 *    this proves the validator is actually reading observations, not just echoing a script.
 */
class WorkerAndRealValidatorMock {
  seenMessages: LlmMessage[][] = [];
  private workerCallIndex = 0;

  constructor(private workerScript: LlmResponse[]) {}

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    this.seenMessages.push(structuredClone(messages));
    const isValidatorCall = messages[0]?.content.includes("independent verification agent");

    if (isValidatorCall) {
      return this.realValidatorLogic(messages);
    }
    const response = this.workerScript[this.workerCallIndex] ?? { content: "(script exhausted)", toolCalls: [] };
    this.workerCallIndex += 1;
    return response;
  }

  /** Real (not scripted) skepticism: reject if the claim mentions something no observation supports. */
  private realValidatorLogic(messages: LlmMessage[]): LlmResponse {
    const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
    const observationsMatch = userMsg.match(/OBSERVATIONS RECORDED DURING THE TASK:\n([\s\S]*?)\n\nAGENT'S CLAIMED/);
    const claimMatch = userMsg.match(/AGENT'S CLAIMED FINAL ANSWER:\n([\s\S]*)/);
    const observations = observationsMatch?.[1] ?? "";
    const claim = claimMatch?.[1] ?? "";

    // Skepticism rule: if the claim says "tests passed" but no observation shows exitCode:0
    // from a test-like command, reject. If the claim says "fixed" but observations show a
    // non-zero exit code anywhere, reject.
    const claimsTestsPassed = /tests? passed|verified|fixed/i.test(claim);
    const hasPassingObservation = /"exitCode":0/.test(observations);
    const hasFailingObservation = /"exitCode":(?!0)\d+/.test(observations);

    if (claimsTestsPassed && (!hasPassingObservation || hasFailingObservation)) {
      return {
        content: JSON.stringify({
          valid: false,
          reason: "Claim asserts success but observations show no passing run (or show a failing exit code).",
        }),
        toolCalls: [],
      };
    }
    return { content: JSON.stringify({ valid: true, reason: "Claim is supported by a passing observation." }), toolCalls: [] };
  }
}

/** Test 2a: a claim NOT backed by any observation gets caught and rejected, agent is told why. */
async function testCatchesUnsupportedClaim() {
  const cwd = path.join(cwdBase, "t2a");
  fs.mkdirSync(cwd, { recursive: true });

  const mock = new WorkerAndRealValidatorMock([
    // Worker hallucinates completion with ZERO tool calls at all -- pure fabrication.
    { content: "task_complete: I fixed the bug and verified all tests passed.", toolCalls: [] },
    // After rejection, worker actually does the work this time.
    { content: "", toolCalls: [toolCall("c1", "run_command_tool", { command: "npm test" })] },
    { content: "task_complete: fixed the bug and verified all tests passed.", toolCalls: [] },
  ]);
  const telemetry = new FileTelemetry(cwd);
  const orchestrator = new ReActOrchestrator(mock, telemetry, { cwd, maxIterations: 10, planMode: "never" });

  // dispatchToolCall for run_command_tool will actually run "npm test" in cwd (no package.json ->
  // real failure), which the real observation transcript will show as non-zero exit -- so the
  // SECOND claim should ALSO get rejected once, proving the validator checks actual exit codes,
  // not just "was a tool called at all". Add a third worker turn for the final honest report.
  mock["workerScript"].push({
    content: "The task cannot be completed as described: there is no npm test script in this workspace to verify against.",
    toolCalls: [],
  });

  const result = await orchestrator.run("fix the bug and make sure tests pass");

  const rejections = mock.seenMessages.filter((msgs) => {
    const sys = msgs[0]?.content ?? "";
    return sys.includes("independent verification agent");
  }).length;

  assert.ok(rejections >= 2, `expected at least 2 validator calls (initial fabrication + follow-up), got ${rejections}`);
  console.log("final accepted answer:", result);
  pass("a completion claim with zero supporting observations is caught by the independent validator and rejected");
}

/** Test 2b: a genuinely supported claim (real passing observation) is accepted without extra retries. */
async function testAcceptsSupportedClaim() {
  const cwd = path.join(cwdBase, "t2b");
  fs.mkdirSync(cwd, { recursive: true });

  const mock = new WorkerAndRealValidatorMock([
    { content: "", toolCalls: [toolCall("c1", "run_command_tool", { command: "echo test-passed && exit 0" })] },
    { content: "tests passed and the change is verified.", toolCalls: [] },
  ]);
  const telemetry = new FileTelemetry(cwd);
  const orchestrator = new ReActOrchestrator(mock, telemetry, { cwd, maxIterations: 10, planMode: "never" });

  const result = await orchestrator.run("run the check and report");
  const validatorCalls = mock.seenMessages.filter((msgs) => msgs[0]?.content.includes("independent verification agent")).length;

  assert.equal(validatorCalls, 1, "a well-supported claim should pass validation on the first check, no retries needed");
  assert.equal(result, "tests passed and the change is verified.");
  pass("a claim genuinely backed by a passing observation is accepted on first validation, no wasted retries");
}

/** Test 2c: persistent hallucination past the retry ceiling is surfaced, not silently accepted or looped forever. */
async function testExhaustsRetriesAndSurfacesGiveUp() {
  const cwd = path.join(cwdBase, "t2c");
  fs.mkdirSync(cwd, { recursive: true });

  // Worker fabricates the same unsupported claim every time, never actually running anything.
  const stubbornLie = { content: "task_complete: definitely fixed, tests definitely passed, trust me.", toolCalls: [] };
  const mock = new WorkerAndRealValidatorMock([stubbornLie, stubbornLie, stubbornLie, stubbornLie, stubbornLie]);
  const telemetry = new FileTelemetry(cwd);
  const orchestrator = new ReActOrchestrator(mock, telemetry, {
    cwd,
    maxIterations: 10,
    planMode: "never",
    maxValidatorRetries: 2,
  });

  const result = await orchestrator.run("fix the bug and verify");
  const sysLog = fs.readFileSync(path.join(cwd, ".agent", "logs", "sys.log"), "utf-8");

  assert.ok(sysLog.includes("validator retries exhausted"), "sys.log should record that validation was exhausted, not silently dropped");
  console.log("final result after exhausted retries:", result);
  pass("persistent hallucination past maxValidatorRetries is surfaced in sys.log rather than looping forever or silently passing");
}

async function main() {
  await testCatchesUnsupportedClaim();
  await testAcceptsSupportedClaim();
  await testExhaustsRetriesAndSurfacesGiveUp();
  console.log(`\n${passCount}/3 goal-validator tests passed.`);
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});


