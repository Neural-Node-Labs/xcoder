import { ReActOrchestrator } from "../core/orchestrator.js";
import { toolCall } from "../llm/mockClient.js";
import { FileTelemetry } from "../telemetry/logger.js";
import { LlmMessage, LlmResponse } from "../core/types.js";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const cwdBase = process.argv[2];
if (!cwdBase) throw new Error("usage: node testPhasePlanning.js <workspace-dir>");

let passCount = 0;
function pass(msg: string) {
  passCount += 1;
  console.log(`PASS: ${msg}`);
}

/**
 * A mock LLM that can be scripted to return specific responses.
 * Tracks which system prompts it was called with so we can verify
 * the phase planning flow was triggered.
 */
class ScriptedMock {
  seenMessages: LlmMessage[][] = [];
  private callIndex = 0;

  constructor(private script: LlmResponse[]) {}

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    this.seenMessages.push(structuredClone(messages));
    const response = this.script[this.callIndex] ?? { content: "(script exhausted)", toolCalls: [] };
    this.callIndex += 1;
    return response;
  }
}

/**
 * Test 1: When phasePlanning is false (default), the orchestrator runs normally
 * without entering phase planning mode. The system prompt should NOT mention
 * "Phase Planning Mode".
 */
async function testPhasePlanningOffByDefault() {
  const cwd = path.join(cwdBase, "t1");
  fs.mkdirSync(cwd, { recursive: true });

  const mock = new ScriptedMock([
    // Worker completes immediately with no tool calls
    { content: "task_complete: simple task done.", toolCalls: [] },
  ]);
  const telemetry = new FileTelemetry(cwd);
  const orchestrator = new ReActOrchestrator(mock, telemetry, {
    cwd,
    maxIterations: 10,
    planMode: "never",
    // phasePlanning is NOT set — defaults to false
  });

  const result = await orchestrator.run("do something simple");

  // Verify the system prompt does NOT mention phase planning
  const systemPrompts = mock.seenMessages.map((msgs) => msgs[0]?.content ?? "");
  const hasPhasePlanningPrompt = systemPrompts.some((p) => p.includes("Phase Planning Mode"));
  assert.equal(hasPhasePlanningPrompt, false, "phase planning should NOT be mentioned when phasePlanning is off");
  assert.equal(result, "task_complete: simple task done.");
  pass("phasePlanning=false: orchestrator runs normally without phase planning");
}

/**
 * Test 2: When phasePlanning is true, the orchestrator enters phase planning mode.
 * The first LLM call should be the phase generation prompt (no tools), and it should
 * contain "Phase Planning Mode" in the system prompt.
 */
async function testPhasePlanningOnGeneratesPhases() {
  const cwd = path.join(cwdBase, "t2");
  fs.mkdirSync(cwd, { recursive: true });

  const mock = new ScriptedMock([
    // Phase generation call (no tools) — returns 2 phases
    {
      content: "### Phase 1: Setup\nPrepare the workspace and gather context.\n\n### Phase 2: Implementation\nImplement the changes based on the setup phase.",
      toolCalls: [],
    },
    // Phase 1 sub-orchestrator call — completes immediately
    { content: "task_complete: setup done.", toolCalls: [] },
    // Phase 1 summary call
    { content: "Setup phase completed. Workspace is ready.", toolCalls: [] },
    // Phase 2 sub-orchestrator call — completes immediately
    { content: "task_complete: implementation done.", toolCalls: [] },
    // Phase 2 summary call
    { content: "Implementation phase completed. All changes applied.", toolCalls: [] },
  ]);
  const telemetry = new FileTelemetry(cwd);
  const orchestrator = new ReActOrchestrator(mock, telemetry, {
    cwd,
    maxIterations: 10,
    planMode: "never",
    interactive: false, // auto-approve phases
    singlePhase: false,
  });

  const result = await orchestrator.run("implement a feature with multiple phases");

  // Verify the first LLM call was the phase generation prompt
  const firstCallMessages = mock.seenMessages[0];
  const firstSystemPrompt = firstCallMessages?.[0]?.content ?? "";
  assert.ok(firstSystemPrompt.includes("Phase Planning Mode"), "first LLM call should be phase generation prompt");
  assert.ok(firstSystemPrompt.includes("Do not call any tools"), "phase generation should forbid tool calls");

  // Verify the result mentions phase planning completed
  assert.ok(result.includes("Phase planning completed"), "result should indicate phase planning completed");
  assert.ok(result.includes("All 2 phases completed"), "result should mention all phases completed");

  pass("phasePlanning=true: orchestrator generates phases and executes them sequentially");
}

/**
 * Test 3: When phasePlanning is true but the LLM returns no parseable phases,
 * the orchestrator falls back to running as a single phase.
 */
async function testPhasePlanningFallbackSinglePhase() {
  const cwd = path.join(cwdBase, "t3");
  fs.mkdirSync(cwd, { recursive: true });

  const mock = new ScriptedMock([
    // Phase generation returns no parseable phases
    { content: "This task is simple enough to be done in one go.", toolCalls: [] },
    // Fallback sub-orchestrator call
    { content: "task_complete: done in one phase.", toolCalls: [] },
  ]);
  const telemetry = new FileTelemetry(cwd);
  const orchestrator = new ReActOrchestrator(mock, telemetry, {
    cwd,
    maxIterations: 10,
    planMode: "never",
    interactive: false,
    singlePhase: false,
  });

  const result = await orchestrator.run("a simple task");

  // Should fall back to single phase execution
  assert.ok(result.includes("done in one phase"), "should fall back to single phase execution");
  pass("phasePlanning=true with no parseable phases: falls back to single phase");
}

/**
 * Test 4: When phasePlanning is true and interactive mode is on, the user is prompted
 * to approve the phases. In non-interactive mode, phases are auto-approved.
 */
async function testPhasePlanningNonInteractiveAutoApproves() {
  const cwd = path.join(cwdBase, "t4");
  fs.mkdirSync(cwd, { recursive: true });

  const mock = new ScriptedMock([
    // Phase generation
    {
      content: "### Phase 1: Research\nResearch the problem.\n\n### Phase 2: Fix\nApply the fix.",
      toolCalls: [],
    },
    // Phase 1 sub-orchestrator
    { content: "task_complete: research done.", toolCalls: [] },
    // Phase 1 summary
    { content: "Research completed. Found the root cause.", toolCalls: [] },
    // Phase 2 sub-orchestrator
    { content: "task_complete: fix applied.", toolCalls: [] },
    // Phase 2 summary
    { content: "Fix applied successfully.", toolCalls: [] },
  ]);
  const telemetry = new FileTelemetry(cwd);
  const orchestrator = new ReActOrchestrator(mock, telemetry, {
    cwd,
    maxIterations: 10,
    planMode: "never",
    interactive: false, // non-interactive = auto-approve
    singlePhase: false,
  });

  const result = await orchestrator.run("fix a bug");

  // Should complete without hanging on stdin
  assert.ok(result.includes("Phase planning completed"), "should complete in non-interactive mode");
  pass("phasePlanning=true in non-interactive mode: phases auto-approved and executed");
}

async function main() {
  await testPhasePlanningOffByDefault();
  await testPhasePlanningOnGeneratesPhases();
  await testPhasePlanningFallbackSinglePhase();
  await testPhasePlanningNonInteractiveAutoApproves();
  console.log(`\n${passCount}/4 phase-planning tests passed.`);
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});

