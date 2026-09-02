import { describe, it, expect } from "vitest";
import { computeAccumulatedTotal } from "../accumulatedTotal.js";

// ─── Phase 3: Compute the New Accumulated Total (Given Prior Value) ──────────────
//
// Accept a hypothetical prior accumulated total (e.g., 10,000) as input.
// Add the current run's total (3,873) to it, producing a new accumulated total
// (e.g., 13,873). Validate the arithmetic and output the result in the same
// format as the input (e.g., "13,873 total accumulated").

describe("computeAccumulatedTotal", () => {
  // ─── Phase 3 Core Scenario ───────────────────────────────────────────────────
  it("adds current run total (3,873) to prior total (10,000) → 13,873", () => {
    const result = computeAccumulatedTotal(3873, 10000);

    expect(result.priorTotal).toBe(10000);
    expect(result.currentRunTotal).toBe(3873);
    expect(result.newTotal).toBe(13873);
    expect(result.formatted).toBe("13,873");
  });

  it("outputs formatted result matching '13,873 total accumulated' pattern", () => {
    const result = computeAccumulatedTotal(3873, 10000);
    const output = `${result.formatted} total accumulated`;

    expect(output).toBe("13,873 total accumulated");
  });

  // ─── Arithmetic Validation ───────────────────────────────────────────────────
  it("validates that priorTotal + currentRunTotal === newTotal", () => {
    const result = computeAccumulatedTotal(3873, 10000);
    expect(result.priorTotal + result.currentRunTotal).toBe(result.newTotal);
  });

  it("handles zero prior total correctly", () => {
    const result = computeAccumulatedTotal(3873, 0);

    expect(result.priorTotal).toBe(0);
    expect(result.currentRunTotal).toBe(3873);
    expect(result.newTotal).toBe(3873);
    expect(result.formatted).toBe("3,873");
  });

  it("handles undefined prior total (defaults to 0)", () => {
    const result = computeAccumulatedTotal(3873);

    expect(result.priorTotal).toBe(0);
    expect(result.currentRunTotal).toBe(3873);
    expect(result.newTotal).toBe(3873);
    expect(result.formatted).toBe("3,873");
  });

  // ─── Large Numbers ───────────────────────────────────────────────────────────
  it("handles large accumulated totals correctly", () => {
    const result = computeAccumulatedTotal(3873, 999999);

    expect(result.newTotal).toBe(1003872);
    expect(result.formatted).toBe("1,003,872");
  });

  it("handles very large prior totals", () => {
    const result = computeAccumulatedTotal(3873, 1_000_000_000);

    expect(result.newTotal).toBe(1_000_003_873);
    expect(result.formatted).toBe("1,000,003,873");
  });

  // ─── Edge Cases ──────────────────────────────────────────────────────────────
  it("handles zero current run total", () => {
    const result = computeAccumulatedTotal(0, 10000);

    expect(result.newTotal).toBe(10000);
    expect(result.formatted).toBe("10,000");
  });

  it("handles both values being zero", () => {
    const result = computeAccumulatedTotal(0, 0);

    expect(result.newTotal).toBe(0);
    expect(result.formatted).toBe("0");
  });

  it("handles single-digit totals", () => {
    const result = computeAccumulatedTotal(5, 3);

    expect(result.newTotal).toBe(8);
    expect(result.formatted).toBe("8");
  });

  // ─── Format Consistency ──────────────────────────────────────────────────────
  it("formats with locale commas for thousands", () => {
    const result = computeAccumulatedTotal(1000, 9000);

    expect(result.formatted).toBe("10,000");
  });

  it("formats with locale commas for millions", () => {
    const result = computeAccumulatedTotal(500_000, 500_000);

    expect(result.formatted).toBe("1,000,000");
  });
});
