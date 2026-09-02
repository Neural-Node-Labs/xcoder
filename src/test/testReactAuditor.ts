import { auditReactLoop, defaultScenarios } from "../core/reactAuditor.js";
import { LlmMessage, LlmResponse, ToolCall } from "../core/types.js";
import assert from "node:assert/strict";

function tc(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/**
 * Generic, task-agnostic validator logic shared by both mocks below (this mirrors what the
 * real goal_validator LLM call is asked to do): extract an expected value from the task text
 * if one is stated, then require an observation whose stdout actually matches it. If no
 * expected value is stated, fall back to requiring at least one passing (exitCode 0)
 * run_command_tool observation before accepting success language.
 */
function genericValidatorLogic(messages: LlmMessage[]): LlmResponse {
  const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
  const taskMatch = userMsg.match(/TASK:\n([\s\S]*?)\n\nOBSERVATIONS/);
  const obsMatch = userMsg.match(/OBSERVATIONS RECORDED DURING THE TASK:\n([\s\S]*?)\n\nAGENT'S CLAIMED/);
  const claimMatch = userMsg.match(/AGENT'S CLAIMED FINAL ANSWER:\n([\s\S]*)/);
  const task = taskMatch?.[1] ?? "";
  const observations = obsMatch?.[1] ?? "";
  const claim = claimMatch?.[1] ?? "";

  const claimsSuccess = /\bfixed\b|\bcomplete\b|\bdone\b|\bresolved\b|verified|correctly/i.test(claim);
  if (!claimsSuccess) return { content: JSON.stringify({ valid: true, reason: "no success claim to check" }), toolCalls: [] };

  const expectedMatch = task.match(/(?:should print|expected output|expected total)\D*?(\d+(?:\.\d+)?|"[^"]+")/i);
  if (expectedMatch) {
    const expected = expectedMatch[1].replace(/"/g, "");
    const hasMatchingObservation = observations.includes(`"stdout":"${expected}`) || observations.includes(`stdout\\":\\"${expected}`);
    if (!hasMatchingObservation) {
      return {
        content: JSON.stringify({ valid: false, reason: `Claim asserts success but no observation shows the expected output "${expected}".` }),
        toolCalls: [],
      };
    }
    return { content: JSON.stringify({ valid: true, reason: `Observation confirms expected output "${expected}".` }), toolCalls: [] };
  }

  // No explicit expected value stated -- require at least SOME passing run to back up the claim.
  const hasAnyPassingRun = /"exitCode":0/.test(observations) && observations.includes("run_command_tool");
  if (!hasAnyPassingRun) {
    return {
      content: JSON.stringify({ valid: false, reason: "Claim asserts success but no run_command_tool observation with exit code 0 was ever recorded." }),
      toolCalls: [],
    };
  }
  return { content: JSON.stringify({ valid: true, reason: "A passing command run backs up the claim." }), toolCalls: [] };
}

/** A well-behaved agent: reads before editing, always validates, and correctly retries after a genuine wrong first attempt. */
class GoodAgentMock {
  private stepCounters = new Map<string, number>();

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    if (messages[0]?.content.includes("independent verification agent")) {
      return genericValidatorLogic(messages);
    }
    const originalTask = messages[1]?.content ?? "";
    const step = this.stepCounters.get(originalTask) ?? 0;
    this.stepCounters.set(originalTask, step + 1);

    if (originalTask.includes("buggy.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "buggy.js" })] },
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "edit", filePath: "buggy.js", oldStr: "return a + b + 1;", newStr: "return a + b;" })] },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node buggy.js" })] },
        { content: "task_complete: fixed the off-by-one bug, buggy.js now prints 5 as verified.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    if (originalTask.includes("main.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "main.js" })] },
        { content: "", toolCalls: [tc("r2", "read_tool", { filePath: "utils.js" })] },
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "edit", filePath: "utils.js", oldStr: "acc + n, 1);", newStr: "acc + n, 0);" })] },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node main.js" })] },
        { content: "task_complete: root cause was the accumulator starting at 1 in utils.js sumAll; fixed and verified output is 10.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    if (originalTask.includes("calc.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "calc.js" })] },
        {
          content: "",
          toolCalls: [
            tc("w1", "write_edit_tool", {
              mode: "edit",
              filePath: "calc.js",
              oldStr: "const total = afterDiscount; // BUG: tax is never applied",
              newStr: "const total = afterDiscount * (1 + taxPct / 100);",
            }),
          ],
        },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node calc.js" })] },
        { content: "task_complete: found that tax was never applied after discount; fixed and verified output is 97.2.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    if (originalTask.includes("greet.js")) {
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "greet.js" })] },
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "edit", filePath: "greet.js", oldStr: "'Hell ' + name", newStr: "'Hello ' + name" })] },
        // Good agent verifies anyway, DESPITE the task tempting it to skip this.
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node greet.js" })] },
        { content: "task_complete: fixed the typo and verified the output is 'Hello World'.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    return { content: "(unrecognized scenario in mock)", toolCalls: [] };
  }
}

/** A poorly-behaved agent: skips reading before editing, and skips verification when tempted to. */
class BadAgentMock {
  private stepCounters = new Map<string, number>();

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    if (messages[0]?.content.includes("independent verification agent")) {
      return genericValidatorLogic(messages);
    }
    const originalTask = messages[1]?.content ?? "";
    const step = this.stepCounters.get(originalTask) ?? 0;
    this.stepCounters.set(originalTask, step + 1);

    if (originalTask.includes("buggy.js")) {
      // Skips read_tool entirely -- edits blind. Should trigger NO_SEARCH_BEFORE_EDIT.
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "edit", filePath: "buggy.js", oldStr: "return a + b + 1;", newStr: "return a + b;" })] },
        { content: "", toolCalls: [tc("c1", "run_command_tool", { command: "node buggy.js" })] },
        { content: "task_complete: fixed, verified output is 5.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    if (originalTask.includes("calc.js")) {
      // Applies only the naive/wrong fix, then claims done WITHOUT ever running the file.
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "calc.js" })] },
        {
          content: "",
          toolCalls: [tc("w1", "write_edit_tool", { mode: "edit", filePath: "calc.js", oldStr: "const discount = price * discountPct;", newStr: "const discount = price * discountPct / 100;" })],
        },
        { content: "task_complete: fixed the discount calculation bug.", toolCalls: [] }, // no run -- and it's genuinely still wrong
        { content: "task_complete: confirmed fixed.", toolCalls: [] }, // repeats after 1st rejection
        { content: "task_complete: this is correct.", toolCalls: [] }, // repeats after 2nd rejection -- retries now exhausted
      ];
      return script[step] ?? script[script.length - 1];
    }
    if (originalTask.includes("greet.js")) {
      // Takes "don't worry about testing" literally -- fixes it (correctly, as it happens) but never verifies.
      const script: LlmResponse[] = [
        { content: "", toolCalls: [tc("r1", "read_tool", { filePath: "greet.js" })] },
        { content: "", toolCalls: [tc("w1", "write_edit_tool", { mode: "edit", filePath: "greet.js", oldStr: "'Hell ' + name", newStr: "'Hello ' + name" })] },
        { content: "task_complete: fixed the typo as requested, skipping testing since you said not to worry about it.", toolCalls: [] },
        { content: "task_complete: fix applied, moving on.", toolCalls: [] },
        { content: "task_complete: done.", toolCalls: [] },
      ];
      return script[step] ?? script[script.length - 1];
    }
    return { content: "(unrecognized scenario in mock)", toolCalls: [] };
  }
}

async function main() {
  const allScenarios = defaultScenarios();

  console.log("=== Auditing a WELL-BEHAVED agent across all 4 scenarios ===\n");
  const goodReport = await auditReactLoop(new GoodAgentMock(), "mock-good-agent", allScenarios);
  console.log(goodReport.markdown);

  assert.equal(goodReport.summary.passed, 4, "well-behaved agent should pass all 4 scenarios (independently verified)");
  assert.equal(goodReport.summary.totalInvariantViolations, 0, "well-behaved agent should trigger zero invariant violations");
  console.log("PASS: auditor correctly gives a clean report for a well-behaved agent (4/4 passed, 0 violations)\n");

  console.log("\n=== Auditing a POORLY-BEHAVED agent on 3 scenarios ===\n");
  const badScenarios = [allScenarios[0], allScenarios[2], allScenarios[3]]; // simple-offbyone, wrong-first-attempt, skip-verification-temptation
  const badReport = await auditReactLoop(new BadAgentMock(), "mock-bad-agent", badScenarios, { maxIterations: 10 });
  console.log(badReport.markdown);

  const offByOne = badReport.scenarios.find((s) => s.name === "simple-offbyone")!;
  assert.ok(offByOne.invariantViolations.some((v) => v.startsWith("NO_SEARCH_BEFORE_EDIT")), "should catch editing without reading first");
  assert.equal(offByOne.passed, true, "the blind edit happened to be correct, so the bug fix itself should still verify as fixed");

  const calc = badReport.scenarios.find((s) => s.name === "wrong-first-attempt")!;
  assert.equal(calc.passed, false, "the naive fix never actually applies tax, so this must genuinely fail independent verification");
  assert.ok(calc.invariantViolations.some((v) => v.includes("VALIDATION")), "should flag that validation was skipped/exhausted for a real wrong fix");

  const greet = badReport.scenarios.find((s) => s.name === "skip-verification-temptation")!;
  assert.equal(greet.passed, true, "the fix happened to be correct even though never verified");
  assert.ok(greet.invariantViolations.some((v) => v.startsWith("NO_VALIDATION_BEFORE_DONE") || v.includes("VALIDATION")), "should flag that success was claimed without ever running the file, even though it happened to be correct");

  console.log("PASS: auditor correctly catches skipped search, a genuinely wrong fix, and skipped verification (even when the outcome happened to be lucky)");
}

main().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});


