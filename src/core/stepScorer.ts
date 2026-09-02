import { ToolCallRecord, findDuplicateActions } from "./duplicateActionDetector.js";
import {
  checkDuplicateReasonRolling,
  maxDuplicatePenalty,
  formatDuplicateReason,
} from "./iterationReasonDedup.js";

export interface StepScore {
  score: number; // 0-100
  reasons: string[];
}

export interface HealthState {
  scores: number[]; // rolling history, oldest first
  callHistory: ToolCallRecord[]; // full run history, reused for duplicate-action detection
  /** Iteration reasons/thoughts from each step, in chronological order. */
  iterationReasons: string[];
}

export function createHealthState(): HealthState {
  return { scores: [], callHistory: [], iterationReasons: [] };
}

/**
 * Heuristic score (0-100) for a single completed tool step, updating `state` as a side effect.
 * This is NOT another LLM call — it's cheap and deterministic on purpose, so it can run on
 * every single step without adding cost or latency. It's a proxy for "did this step move the
 * task forward", not a quality judgment: a passing test run scores well, a repeated no-op
 * action scores poorly, regardless of how clever the reasoning behind it was.
 *
 * The three signals that matter most:
 *   - Did the tool call error?
 *   - Is this an exact repeat of an earlier (tool, args) pair that already produced this exact
 *     same observation? (Reusing duplicateActionDetector.ts's definition of "duplicate" —
 *     same call, same result, meaning nothing new was learned by repeating it.)
 *   - Does the iteration reason/thought repeat a previous iteration's reasoning?
 *     (Using iterationReasonDedup.ts's three-pass matching: exact, case-insensitive, fuzzy.)
 *
 * ⚠️ NOTE: The `thought` parameter is optional and currently NOT passed by any call site.
 * The duplicate iteration reason check is dormant in production. See iterationReasonDedup.ts
 * for the full status and activation instructions.
 */
export function scoreStep(
  state: HealthState,
  step: { tool: string; args: unknown; observation: unknown; isError: boolean; thought?: string }
): StepScore {
  state.callHistory.push({ tool: step.tool, args: step.args, observation: step.observation });

  let score = 70; // neutral baseline for "completed, nothing notable either way"
  const reasons: string[] = [];

  if (step.isError) {
    score -= 45;
    reasons.push("tool call errored");
  } else {
    score += 10;
    reasons.push("completed without error");
  }

  const violations = findDuplicateActions(state.callHistory);
  const isDuplicate = violations.some((v) => v.tool === step.tool && sameArgs(v.args, step.args));
  if (isDuplicate) {
    score -= 35;
    reasons.push("repeated an identical action with an identical result — no new information gained");
  }

  // Check for duplicate iteration reason (thought/reasoning).
  // Only check if we have a thought string and at least one prior reason to compare against.
  if (step.thought && state.iterationReasons.length > 0) {
    const reasonViolations = checkDuplicateReasonRolling(
      state.iterationReasons,
      step.thought
    );
    if (reasonViolations.length > 0) {
      const penalty = maxDuplicatePenalty(reasonViolations);
      score -= penalty;
      reasons.push(formatDuplicateReason(reasonViolations));
    }
  }

  // Record the iteration reason for future duplicate checks (even if empty — preserves indexing).
  state.iterationReasons.push(step.thought ?? "");

  // Mild reward for actions that typically represent real forward progress on a coding task.
  if (!step.isError && (step.tool === "write_edit_tool" || step.tool === "run_command_tool")) {
    score += 10;
    reasons.push(`${step.tool} succeeded`);
  }

  score = Math.max(0, Math.min(100, score));
  state.scores.push(score);
  return { score, reasons };
}

/** Rolling average over the last `window` scores (default 5). 100 (no signal yet) if empty. */
export function rollingHealth(state: HealthState, window = 5): number {
  if (state.scores.length === 0) return 100;
  const recent = state.scores.slice(-window);
  return Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
}

function sameArgs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
