import { describe, it, expect } from "vitest";
import { accumulateTaskTokens, TaskTokenSummary } from "../taskTokenTracker.js";
import { ParsedTokenCounts } from "../tokenParser.js";

// ─── Phase 2: Per-Task Token Accumulation Data Model ──────────────────────────
//
// Define the new data model (interfaces/types) for per-task token tracking.
// Implement a `accumulateTaskTokens(taskId, phaseId, parsedCounts)` function that:
//   - Adds the current phase's token counts to the task's phase map
//   - Recomputes the task's running total as the sum of all phase totals
//     (using `expectedTotal` for arithmetic accuracy)
//   - Returns the updated per-task summary (phase breakdown + running total)

describe("accumulateTaskTokens", () => {
  // ─── Helper: create a ParsedTokenCounts fixture ────────────────────────────
  function makeCounts(
    overrides: Partial<ParsedTokenCounts> = {}
  ): ParsedTokenCounts {
    return {
      input: 3592,
      output: 281,
      cached: 2944,
      total: 3873,
      discrepancy: false,
      expectedTotal: 6817,
      ...overrides,
    };
  }

  // ─── Core Scenario: First Phase ────────────────────────────────────────────
  it("creates a new summary with the first phase's token counts", () => {
    const counts = makeCounts();
    const result = accumulateTaskTokens("task-1", "search", counts);

    // Phase map should contain the search phase
    expect(result.phases["search"]).toBeDefined();
    expect(result.phases["search"].input).toBe(3592);
    expect(result.phases["search"].output).toBe(281);
    expect(result.phases["search"].cached).toBe(2944);
    expect(result.phases["search"].total).toBe(3873);
    expect(result.phases["search"].expectedTotal).toBe(6817);

    // Running total should equal the first phase's expectedTotal
    expect(result.runningTotal).toBe(6817);
  });

  it("returns a summary with exactly one phase entry for the first phase", () => {
    const counts = makeCounts();
    const result = accumulateTaskTokens("task-1", "search", counts);

    expect(Object.keys(result.phases)).toHaveLength(1);
    expect(result.phases["search"]).toBeDefined();
  });

  // ─── Multiple Phases ──────────────────────────────────────────────────────
  it("accumulates multiple phases into the same task summary", () => {
    const searchCounts = makeCounts({ expectedTotal: 6817 });
    const actionCounts = makeCounts({
      input: 1500,
      output: 300,
      cached: 200,
      total: 2000,
      expectedTotal: 2000,
    });
    const validationCounts = makeCounts({
      input: 800,
      output: 100,
      cached: 100,
      total: 1000,
      expectedTotal: 1000,
    });

    // Add search phase
    let result = accumulateTaskTokens("task-1", "search", searchCounts);
    expect(result.runningTotal).toBe(6817);

    // Add action phase
    result = accumulateTaskTokens("task-1", "action", actionCounts, result);
    expect(result.runningTotal).toBe(6817 + 2000); // 8817

    // Add validation phase
    result = accumulateTaskTokens("task-1", "validation", validationCounts, result);
    expect(result.runningTotal).toBe(6817 + 2000 + 1000); // 9817
  });

  it("maintains all phase entries when accumulating", () => {
    const searchCounts = makeCounts({ expectedTotal: 6817 });
    const actionCounts = makeCounts({
      input: 1500,
      output: 300,
      cached: 200,
      total: 2000,
      expectedTotal: 2000,
    });

    let result = accumulateTaskTokens("task-1", "search", searchCounts);
    result = accumulateTaskTokens("task-1", "action", actionCounts, result);

    expect(Object.keys(result.phases)).toHaveLength(2);
    expect(result.phases["search"]).toBeDefined();
    expect(result.phases["action"]).toBeDefined();
  });

  // ─── Running Total Uses expectedTotal (Arithmetic Accuracy) ────────────────
  it("uses expectedTotal (not total) for running total arithmetic", () => {
    // Simulate a discrepancy: total !== expectedTotal
    const counts = makeCounts({
      input: 3592,
      output: 281,
      cached: 2944,
      total: 3873, // reported total (excludes cached)
      expectedTotal: 6817, // actual sum: 3592 + 281 + 2944
      discrepancy: true,
    });

    const result = accumulateTaskTokens("task-1", "search", counts);

    // Running total should use expectedTotal (6817), not total (3873)
    expect(result.runningTotal).toBe(6817);
    expect(result.runningTotal).not.toBe(3873);
  });

  it("recomputes running total correctly when phases have discrepancies", () => {
    const phase1 = makeCounts({
      input: 1000,
      output: 200,
      cached: 300,
      total: 1200, // reported total (excludes cached)
      expectedTotal: 1500, // 1000 + 200 + 300
      discrepancy: true,
    });
    const phase2 = makeCounts({
      input: 500,
      output: 100,
      cached: 0,
      total: 600,
      expectedTotal: 600,
      discrepancy: false,
    });

    let result = accumulateTaskTokens("task-1", "phase-1", phase1);
    expect(result.runningTotal).toBe(1500);

    result = accumulateTaskTokens("task-1", "phase-2", phase2, result);
    expect(result.runningTotal).toBe(1500 + 600); // 2100
  });

  // ─── Overwriting an Existing Phase ─────────────────────────────────────────
  it("overwrites an existing phase entry (last-write-wins)", () => {
    const original = makeCounts({ expectedTotal: 1000 });
    const updated = makeCounts({ expectedTotal: 2000 });

    let result = accumulateTaskTokens("task-1", "search", original);
    expect(result.phases["search"].expectedTotal).toBe(1000);
    expect(result.runningTotal).toBe(1000);

    // Overwrite the same phase
    result = accumulateTaskTokens("task-1", "search", updated, result);
    expect(result.phases["search"].expectedTotal).toBe(2000);
    expect(result.runningTotal).toBe(2000);
  });

  it("does not mutate the existing summary when overwriting", () => {
    const original = makeCounts({ expectedTotal: 1000 });
    const updated = makeCounts({ expectedTotal: 2000 });

    const firstResult = accumulateTaskTokens("task-1", "search", original);
    const originalPhases = { ...firstResult.phases };

    accumulateTaskTokens("task-1", "search", updated, firstResult);

    // The original result should be unchanged (immutability)
    expect(firstResult.phases["search"].expectedTotal).toBe(1000);
    expect(firstResult.runningTotal).toBe(1000);
  });

  // ─── No Existing Summary (Starting Fresh) ──────────────────────────────────
  it("starts fresh when no existing summary is provided", () => {
    const counts = makeCounts();
    const result = accumulateTaskTokens("task-1", "search", counts);

    expect(result.phases["search"]).toBeDefined();
    expect(Object.keys(result.phases)).toHaveLength(1);
    expect(result.runningTotal).toBe(counts.expectedTotal);
  });

  // ─── Edge Cases ────────────────────────────────────────────────────────────
  it("handles zero token counts correctly", () => {
    const zeroCounts = makeCounts({
      input: 0,
      output: 0,
      cached: 0,
      total: 0,
      expectedTotal: 0,
    });

    const result = accumulateTaskTokens("task-1", "empty-phase", zeroCounts);

    expect(result.phases["empty-phase"].input).toBe(0);
    expect(result.phases["empty-phase"].output).toBe(0);
    expect(result.phases["empty-phase"].cached).toBe(0);
    expect(result.phases["empty-phase"].total).toBe(0);
    expect(result.phases["empty-phase"].expectedTotal).toBe(0);
    expect(result.runningTotal).toBe(0);
  });

  it("handles very large token counts", () => {
    const largeCounts = makeCounts({
      input: 1_000_000,
      output: 500_000,
      cached: 250_000,
      total: 1_750_000,
      expectedTotal: 1_750_000,
    });

    const result = accumulateTaskTokens("task-1", "large-phase", largeCounts);

    expect(result.phases["large-phase"].input).toBe(1_000_000);
    expect(result.phases["large-phase"].output).toBe(500_000);
    expect(result.phases["large-phase"].cached).toBe(250_000);
    expect(result.phases["large-phase"].expectedTotal).toBe(1_750_000);
    expect(result.runningTotal).toBe(1_750_000);
  });

  it("handles multiple phases with large numbers", () => {
    const phase1 = makeCounts({ expectedTotal: 5_000_000 });
    const phase2 = makeCounts({ expectedTotal: 3_000_000 });
    const phase3 = makeCounts({ expectedTotal: 2_000_000 });

    let result = accumulateTaskTokens("task-1", "phase-1", phase1);
    result = accumulateTaskTokens("task-1", "phase-2", phase2, result);
    result = accumulateTaskTokens("task-1", "phase-3", phase3, result);

    expect(result.runningTotal).toBe(10_000_000);
  });

  it("handles phase IDs with special characters", () => {
    const counts = makeCounts();
    const result = accumulateTaskTokens(
      "task-1",
      "phase-with-special_chars@123",
      counts
    );

    expect(result.phases["phase-with-special_chars@123"]).toBeDefined();
    expect(result.runningTotal).toBe(counts.expectedTotal);
  });

  // ─── Immutability ──────────────────────────────────────────────────────────
  it("does not mutate the input parsedCounts object", () => {
    const counts = makeCounts();
    const countsCopy = { ...counts };

    accumulateTaskTokens("task-1", "search", counts);

    expect(counts).toEqual(countsCopy);
  });

  it("returns a new object each time (immutability)", () => {
    const counts = makeCounts();
    const result1 = accumulateTaskTokens("task-1", "search", counts);
    const result2 = accumulateTaskTokens("task-1", "search", counts);

    // Same inputs should produce structurally equal but distinct objects
    expect(result1).toEqual(result2);
    expect(result1).not.toBe(result2);
  });

  // ─── Type Contract ─────────────────────────────────────────────────────────
  it("returns a TaskTokenSummary with the correct shape", () => {
    const counts = makeCounts();
    const result = accumulateTaskTokens("task-1", "search", counts);

    // Check the interface contract
    const summary: TaskTokenSummary = result;
    expect(summary).toHaveProperty("phases");
    expect(summary).toHaveProperty("runningTotal");
    expect(typeof summary.runningTotal).toBe("number");
    expect(typeof summary.phases).toBe("object");
    expect(Array.isArray(summary.phases)).toBe(false); // it's a Record, not an array
  });

  it("stores PhaseTokenUsage (ParsedTokenCounts) correctly in phases", () => {
    const counts = makeCounts();
    const result = accumulateTaskTokens("task-1", "search", counts);

    const phase = result.phases["search"];
    expect(phase).toHaveProperty("input");
    expect(phase).toHaveProperty("output");
    expect(phase).toHaveProperty("cached");
    expect(phase).toHaveProperty("total");
    expect(phase).toHaveProperty("discrepancy");
    expect(phase).toHaveProperty("expectedTotal");
    expect(typeof phase.input).toBe("number");
    expect(typeof phase.output).toBe("number");
    expect(typeof phase.cached).toBe("number");
    expect(typeof phase.total).toBe("number");
    expect(typeof phase.discrepancy).toBe("boolean");
    expect(typeof phase.expectedTotal).toBe("number");
  });
});
