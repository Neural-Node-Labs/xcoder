/**
 * Per-Task Token Tracker
 *
 * Tracks token usage at the task level, with per-phase breakdowns and a running
 * total computed from the arithmetic sum of all phase totals (using `expectedTotal`
 * for accuracy, not the potentially-discrepant `total` field).
 *
 * ## Data Model
 *
 * ```
 * TaskTokenSummary {
 *   phases: { [phaseId: string]: PhaseTokenUsage }   // per-phase breakdown
 *   runningTotal: number                               // sum of all phase expectedTotals
 * }
 * ```
 *
 * ## Usage
 *
 * ```ts
 * import { accumulateTaskTokens, usageToParsedCounts } from "./taskTokenTracker.js";
 * import { parseTokenCounts } from "./tokenParser.js";
 *
 * const parsed = parseTokenCounts("3,592 in · 281 out · 2,944 cached — 3,873 total");
 * const summary = accumulateTaskTokens("task-123", "search", parsed);
 * // summary.runningTotal === 6817 (expectedTotal)
 * // summary.phases["search"] === parsed
 * ```
 *
 * The function is pure and stateless — it takes an optional existing map and returns
 * a new (shallow-copied) summary. Callers are responsible for persisting the result.
 */

import { ParsedTokenCounts } from "./tokenParser.js";
import { LlmUsage } from "./types.js";

/**
 * Token usage for a single phase within a task.
 * Reuses ParsedTokenCounts from tokenParser.ts, which includes input, output,
 * cached, total, discrepancy flag, and expectedTotal.
 */
export type PhaseTokenUsage = ParsedTokenCounts;

/**
 * Per-task summary of token usage across all phases.
 *
 * - `phases`: A map of phase IDs (e.g. "search", "action", "validation", or
 *   custom phase names like "planning", "phase-1") to their parsed token counts.
 * - `runningTotal`: The arithmetic sum of all phase `expectedTotal` values.
 *   This is the authoritative running total for the task, computed from the
 *   actual token components rather than relying on the potentially-discrepant
 *   `total` field reported by the LLM.
 */
export interface TaskTokenSummary {
  /** Per-phase token usage, keyed by phase ID. */
  phases: Record<string, PhaseTokenUsage>;
  /** Running total computed as sum of all phase expectedTotals. */
  runningTotal: number;
}

/**
 * Accumulate token counts for a specific phase of a task.
 *
 * If the phase already exists in the map, it is overwritten with the new counts
 * (last-write-wins — each phase should only be recorded once per run).
 *
 * After adding/updating the phase, the running total is recomputed as the sum
 * of all phase `expectedTotal` values. This ensures the running total is always
 * accurate even if individual phase totals have discrepancies.
 *
 * @param taskId - Unique identifier for the task (used for logging/errors only).
 * @param phaseId - Identifier for the phase (e.g. "search", "action", "validation", "planning").
 * @param parsedCounts - The parsed token counts for this phase (from parseTokenCounts).
 * @param existingSummary - Optional existing TaskTokenSummary to accumulate into.
 *                          If omitted, a new summary is created.
 * @returns The updated TaskTokenSummary with the new phase added and running total recomputed.
 */
export function accumulateTaskTokens(
  taskId: string,
  phaseId: string,
  parsedCounts: ParsedTokenCounts,
  existingSummary?: TaskTokenSummary
): TaskTokenSummary {
  // Start from the existing summary or create a new one
  const summary: TaskTokenSummary = existingSummary
    ? {
        phases: { ...existingSummary.phases },
        runningTotal: 0, // will be recomputed below
      }
    : {
        phases: {},
        runningTotal: 0,
      };

  // Add or update the phase entry (last-write-wins)
  summary.phases[phaseId] = { ...parsedCounts };

  // Recompute running total as the sum of all phase expectedTotals
  // Using expectedTotal for arithmetic accuracy (see tokenParser.ts for why
  // the reported `total` may differ from input + output + cached).
  let recomputedTotal = 0;
  for (const phaseKey of Object.keys(summary.phases)) {
    recomputedTotal += summary.phases[phaseKey].expectedTotal;
  }
  summary.runningTotal = recomputedTotal;

  return summary;
}

/**
 * Convert an LlmUsage object (from the LLM client) to a ParsedTokenCounts object
 * suitable for passing to accumulateTaskTokens().
 *
 * This bridges the gap between the LLM client's usage reporting format and the
 * per-task token tracker's expected input format. Since LlmUsage already has
 * structured fields (promptTokens, completionTokens, totalTokens, cachedTokens),
 * we can construct the ParsedTokenCounts directly without parsing a string.
 *
 * The `expectedTotal` is computed as promptTokens + completionTokens + cachedTokens,
 * and the `discrepancy` flag is set if this differs from the reported `totalTokens`.
 *
 * @param usage - The LlmUsage object from an LLM response.
 * @returns A ParsedTokenCounts object ready for accumulateTaskTokens().
 */
export function usageToParsedCounts(usage: LlmUsage): ParsedTokenCounts {
  const input = usage.promptTokens;
  const output = usage.completionTokens;
  const cached = usage.cachedTokens ?? 0;
  const total = usage.totalTokens;
  const expectedTotal = input + output + cached;
  const discrepancy = total !== expectedTotal;

  return {
    input,
    output,
    cached,
    total,
    discrepancy,
    expectedTotal,
  };
}
