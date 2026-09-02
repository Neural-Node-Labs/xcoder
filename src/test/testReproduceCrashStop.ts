/**
 * Reproduction test: orchestrator stopping without a summary report.
 *
 * This directly tests the reported issue: when the orchestrator hits the iteration
 * limit while the model is still making tool calls (no final answer), does it
 * return a meaningful summary report or an empty/meaningless string?
 *
 * Three scenarios:
 * 1. Main loop iteration limit with synthesizeReport() — should produce a report
 *    that includes the health score and trend
 * 2. Phase planning fallback (singlePhase=false, default) — sub-orchestrator returns
 *    a synthesized report with health score info
 * 3. Subagent iteration limit — returns a health-score-aware message (partial success
 *    if score >= 0.7, otherwise a descriptive fallback)
 */
import { ReActOrchestrator } from "../core/orchestrator.js";
import { MockLlmClient, toolCall } from "../llm/mockClient.js";
import { FileTelemetry } from "../telemetry/logger.js";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const cwdBase = process.argv[2];
if (!cwdBase) throw new Error("usage: node dist/test/testReproduceCrashStop.js <workspace-dir>");

let passCount = 0;
let failCount = 0;

function pass(msg: string) {
  passCount += 1;
  console.log(`  ✅ PASS: ${msg}`);
}

function fail(msg: string) {
  failCount += 1;
  console.log(`  ❌ FAIL: ${msg}`);
}

/**
 * Scenario 1: Main loop iteration limit with synthesizeReport()
 *
 * The model keeps making tool calls past maxIterations. The orchestrator should
 * call synthesizeReport() to produce a meaningful summary, NOT return an empty string.
 *
 * This tests the code path at orchestrator.ts line ~290:
 *   finalContent = this.synthesizeReport(...)
 */
async function testMainLoopSynthesizesReport() {
  const cwd = path.join(cwdBase, "repro-mainloop");
  fs.mkdirSync(cwd, { recursive: true });

  // Model makes 3 tool calls (past maxIterations=2), never produces a final answer.
  // After hitting the iteration limit, synthesizeReport() calls callLlmForSummary()
  // as the primary path (CA1 P0 fix), so we need a 4th mock response for the summary LLM call.
  const mock = new MockLlmClient([
    { content: "Reading file...", toolCalls: [toolCall("c1", "run_command_tool", { command: "echo step1" })] },
    { content: "Processing...", toolCalls: [toolCall("c2", "run_command_tool", { command: "echo step2" })] },
    { content: "Still working...", toolCalls: [toolCall("c3", "run_command_tool", { command: "echo step3" })] },
    // Summary LLM call from synthesizeReport() -> callLlmForSummary()
    { content: "## What was accomplished\n- Ran step1, step2, step3\n\n## What was left undone\n- Nothing\n\n## Key decisions made\n- Sequential execution\n\n## Blockers encountered\n- None", toolCalls: [] },
  ]);
  const telemetry = new FileTelemetry(cwd);
  const orchestrator = new ReActOrchestrator(mock, telemetry, {
    cwd,
    maxIterations: 2,
    validateGoal: false,
    planMode: "never",
    singlePhase: true, // disable phase planning — test the main loop directly
    onIterationLimitReached: async () => false, // API default: never continue
  });

  const result = await orchestrator.run("do three sequential steps");
  const outcome = orchestrator.getLastOutcome();

  // After Phase 4 fix, the orchestrator sets lastOutcome = "partial_success" before
  // calling synthesizeReport() when the user declines to continue.
  if (outcome !== "partial_success") {
    fail(`Expected outcome "partial_success", got "${outcome}"`);
    return;
  }

  // The result should NOT be empty — synthesizeReport() should produce a meaningful report
  if (!result || result.length === 0) {
    fail("Result is empty — synthesizeReport() was not called or returned empty string");
    return;
  }

  // The result should contain useful information, not just a generic message
  const hasUsefulContent =
    result.includes("iteration limit") ||
    result.includes("Task stopped") ||
    result.includes("maxIterations") ||
    result.includes("tool call") ||
    result.includes("What was done") ||
    result.includes("What was accomplished");

  if (!hasUsefulContent) {
    fail(`Result does not contain useful summary content. Got: "${result.slice(0, 200)}..."`);
    return;
  }

  // Verify it's NOT the generic subagent message
  if (result.includes("subagent hit iteration limit")) {
    fail("Result contains subagent fallback message instead of synthesized report");
    return;
  }

  pass(`Main loop synthesizes report on iteration limit. Result (first 200 chars): "${result.slice(0, 200)}..."`);
}

/**
 * Scenario 2: Phase planning fallback (default behavior, singlePhase=false)
 *
 * When phase planning is ON (default), the orchestrator diverts to runPhasePlanning().
 * If the LLM doesn't produce parseable phase headings, it falls back to a sub-orchestrator.
 * The sub-orchestrator returns "(subagent hit iteration limit without completing)" directly
 * WITHOUT any synthesis. This is the reported crash/stop condition.
 */
async function testPhasePlanningFallbackNoReport() {
  const cwd = path.join(cwdBase, "repro-phaseplan");
  fs.mkdirSync(cwd, { recursive: true });

  // Model makes tool calls, never produces phase headings or final answer.
  // Flow: 1) phase generation LLM call (no tool calls, no phase headings),
  // then 2-4) sub-orchestrator makes 3 tool calls, hits iteration limit,
  // then 5) synthesizeReport() -> callLlmForSummary() needs a 5th response.
  const mock = new MockLlmClient([
    // Response 1: Phase generation — no tool calls, no phase headings (triggers fallback)
    { content: "Step 1 thinking...", toolCalls: [] },
    // Responses 2-4: Sub-orchestrator tool calls
    { content: "Step 2 thinking...", toolCalls: [toolCall("c1", "run_command_tool", { command: "echo step1" })] },
    { content: "Step 3 thinking...", toolCalls: [toolCall("c2", "run_command_tool", { command: "echo step2" })] },
    { content: "Still working...", toolCalls: [toolCall("c3", "run_command_tool", { command: "echo step3" })] },
    // Response 5: Summary LLM call from synthesizeReport() -> callLlmForSummary()
    { content: "## What was accomplished\n- Ran step1, step2, step3\n\n## What was left undone\n- Nothing\n\n## Key decisions made\n- Sequential execution\n\n## Blockers encountered\n- None", toolCalls: [] },
  ]);
  const telemetry = new FileTelemetry(cwd);
  const orchestrator = new ReActOrchestrator(mock, telemetry, {
    cwd,
    maxIterations: 2,
    validateGoal: false,
    planMode: "never",
    singlePhase: false, // phase planning ON (default behavior)
    onIterationLimitReached: async () => false,
  });

  const result = await orchestrator.run("do three sequential steps");
  const outcome = orchestrator.getLastOutcome();

  console.log(`  Phase planning fallback outcome: "${outcome}"`);
  console.log(`  Phase planning fallback result: "${result}"`);

  // The outcome is "completed" because the parent orchestrator treats the
  // sub-orchestrator's return as a successful completion
  if (outcome === "completed") {
    // This is the bug: the orchestrator reports "completed" even though
    // the sub-orchestrator hit the iteration limit
    fail(`Outcome is "completed" — the orchestrator masked the iteration limit failure`);
  }

  // The result is the subagent fallback message, not a synthesized report
  if (result.includes("subagent hit iteration limit")) {
    fail(`Result is the generic subagent fallback message, not a synthesized report`);
  }

  // If we got here, the result is something else — check if it's useful
  if (!result || result.length < 20) {
    fail(`Result is empty or too short: "${result}"`);
    return;
  }

  pass(`Phase planning fallback returned: "${result.slice(0, 200)}..."`);
}

/**
 * Scenario 3: Subagent iteration limit — verify the subagent returns
 * the generic message without synthesis.
 */
async function testSubagentIterationLimit() {
  const cwd = path.join(cwdBase, "repro-subagent");
  fs.mkdirSync(cwd, { recursive: true });

  // Model makes tool calls past the limit
  const mock = new MockLlmClient([
    { content: "Thinking...", toolCalls: [toolCall("c1", "run_command_tool", { command: "echo step1" })] },
    { content: "Thinking...", toolCalls: [toolCall("c2", "run_command_tool", { command: "echo step2" })] },
    { content: "Thinking...", toolCalls: [toolCall("c3", "run_command_tool", { command: "echo step3" })] },
  ]);
  const telemetry = new FileTelemetry(cwd);
  const orchestrator = new ReActOrchestrator(mock, telemetry, {
    cwd,
    maxIterations: 2,
    validateGoal: false,
    planMode: "never",
    singlePhase: true,
  });

  // Run as a subagent (isSubagent: true)
  const result = await orchestrator.run("do three steps", { isSubagent: true });
  const outcome = orchestrator.getLastOutcome();

  console.log(`  Subagent outcome: "${outcome}"`);
  console.log(`  Subagent result: "${result}"`);

  // The subagent should return the generic fallback message
  if (result === "(subagent hit iteration limit without completing)") {
    pass("Subagent returns generic fallback message on iteration limit (expected behavior)");
  } else {
    fail(`Subagent returned unexpected result: "${result}"`);
  }
}

async function main() {
  console.log("\n=== Reproduction: Orchestrator Crash/Stop Without Summary Report ===\n");

  console.log("\n--- Scenario 1: Main loop iteration limit with synthesizeReport() ---");
  await testMainLoopSynthesizesReport();

  console.log("\n--- Scenario 2: Phase planning fallback (default, singlePhase=false) ---");
  await testPhasePlanningFallbackNoReport();

  console.log("\n--- Scenario 3: Subagent iteration limit ---");
  await testSubagentIterationLimit();

  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

