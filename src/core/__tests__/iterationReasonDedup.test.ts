import { describe, it, expect } from "vitest";
import {
  checkDuplicateReason,
  checkDuplicateReasonRolling,
  maxDuplicatePenalty,
  formatDuplicateReason,
  DuplicateReasonViolation,
} from "../iterationReasonDedup.js";

// ─── No Duplicates ───────────────────────────────────────────────────────────────

describe("no duplicates", () => {
  it("returns empty array when previousReasons is empty", () => {
    const result = checkDuplicateReason([], "some reason");
    expect(result).toEqual([]);
  });

  it("returns empty array when newReason is empty string", () => {
    const result = checkDuplicateReason(["previous reason"], "");
    expect(result).toEqual([]);
  });

  it("returns empty array when newReason is whitespace-only", () => {
    const result = checkDuplicateReason(["previous reason"], "   ");
    expect(result).toEqual([]);
  });

  it("returns empty array when all reasons are unique", () => {
    const result = checkDuplicateReason(
      [
        "first unique reason",
        "second unique reason",
        "third unique reason",
      ],
      "fourth completely different reason"
    );
    expect(result).toEqual([]);
  });

  it("returns empty array with a single previous reason that differs", () => {
    const result = checkDuplicateReason(["hello world"], "goodbye world");
    expect(result).toEqual([]);
  });
});

// ─── Exact Duplicates ────────────────────────────────────────────────────────────

describe("exact duplicates", () => {
  it("detects exact duplicate match", () => {
    const result = checkDuplicateReason(
      ["I need to read the file first"],
      "I need to read the file first"
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("exact");
    expect(result[0].similarity).toBe(1.0);
    expect(result[0].penalty).toBe(25);
    expect(result[0].originalIndex).toBe(0);
    expect(result[0].duplicateIndex).toBe(1);
  });

  it("detects exact duplicate with leading/trailing whitespace", () => {
    const result = checkDuplicateReason(
      ["  check the logs  "],
      "check the logs"
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("exact");
  });

  it("detects exact duplicate among multiple previous reasons", () => {
    const result = checkDuplicateReason(
      [
        "first reason",
        "second reason",
        "third reason",
      ],
      "second reason"
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("exact");
    expect(result[0].originalIndex).toBe(1);
  });

  it("detects exact duplicate against the most recent reason", () => {
    const result = checkDuplicateReason(
      [
        "old reason",
        "middle reason",
        "recent reason",
      ],
      "recent reason"
    );
    expect(result).toHaveLength(1);
    expect(result[0].originalIndex).toBe(2);
  });
});

// ─── Case-Insensitive Duplicates ─────────────────────────────────────────────────

describe("case-insensitive duplicates", () => {
  it("detects case-insensitive duplicate (different casing)", () => {
    const result = checkDuplicateReason(
      ["Check The Logs For Errors"],
      "check the logs for errors"
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("case_insensitive");
    expect(result[0].similarity).toBe(1.0);
    expect(result[0].penalty).toBe(20);
  });

  it("detects case-insensitive duplicate with mixed casing", () => {
    const result = checkDuplicateReason(
      ["i NEED to READ the file"],
      "I need to read the file"
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("case_insensitive");
  });

  it("does not flag case-insensitive when disabled", () => {
    const result = checkDuplicateReason(
      ["Check The Logs"],
      "check the logs",
      { enableCaseInsensitive: false }
    );
    expect(result).toHaveLength(0);
  });

  it("prefers exact match over case-insensitive when both apply", () => {
    const result = checkDuplicateReason(
      ["same text", "SAME TEXT"],
      "same text"
    );
    // Should match exact against index 0, not case-insensitive against index 1
    // (or both, but sorted with exact first)
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].matchType).toBe("exact");
  });
});

// ─── Fuzzy Duplicates ────────────────────────────────────────────────────────────

describe("fuzzy duplicates", () => {
  it("detects fuzzy duplicate with high similarity", () => {
    const result = checkDuplicateReason(
      ["I need to read the configuration file to understand the setup"],
      "I need to read the configuration file to understand the setup process"
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("fuzzy");
    expect(result[0].similarity).toBeGreaterThanOrEqual(0.85);
    expect(result[0].penalty).toBe(15);
  });

  it("does not flag strings below fuzzy threshold", () => {
    const result = checkDuplicateReason(
      ["The quick brown fox jumps over the lazy dog"],
      "Completely unrelated sentence about something else entirely"
    );
    expect(result).toHaveLength(0);
  });

  it("does not fuzzy-match short strings (short-string guard)", () => {
    const result = checkDuplicateReason(
      ["short string"],
      "short string!"
    );
    // Both are < 20 chars, so fuzzy is skipped; they're not exact or case-insensitive
    expect(result).toHaveLength(0);
  });

  it("respects custom fuzzy threshold", () => {
    const result = checkDuplicateReason(
      ["This is a fairly long sentence about reading files and parsing data"],
      "This is a fairly long sentence about reading files and parsing results",
      { fuzzyThreshold: 0.95 }
    );
    // With a higher threshold (0.95), this might not match
    // The strings differ by a few words, so similarity is likely < 0.95
    expect(result).toHaveLength(0);
  });

  it("does not fuzzy-match when fuzzy matching is disabled", () => {
    const result = checkDuplicateReason(
      ["This is a long sentence about reading configuration files from the system"],
      "This is a long sentence about reading configuration files from the server",
      { enableFuzzy: false }
    );
    expect(result).toHaveLength(0);
  });

  it("fuzzy matches identical long strings (should be caught by exact first)", () => {
    const longStr = "This is a very long string that exceeds the short string minimum length threshold for fuzzy matching purposes";
    const result = checkDuplicateReason([longStr], longStr);
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("exact"); // exact takes priority
  });
});

// ─── Rolling Window ──────────────────────────────────────────────────────────────

describe("rolling window", () => {
  it("only checks against the last N reasons", () => {
    const reasons = [
      "old reason that is very long and should not be matched against",
      "another old reason that is also very long and should not match",
      "recent reason that is long enough for fuzzy matching purposes here",
    ];
    const newReason = "recent reason that is long enough for fuzzy matching purposes here";
    // With window=1, only check against the last one
    const result = checkDuplicateReasonRolling(reasons, newReason, 1);
    expect(result).toHaveLength(1);
    // originalIndex is relative to the sliced window (only 1 element), so it's 0
    expect(result[0].originalIndex).toBe(0);
  });

  it("returns empty when duplicate is outside the window", () => {
    const reasons = [
      "duplicate reason that is long enough for fuzzy matching here",
      "some other reason that is different from the first one",
      "yet another different reason that is not the same as the first",
    ];
    const newReason = "duplicate reason that is long enough for fuzzy matching here";
    // With window=1, only check against the last one (which is different)
    const result = checkDuplicateReasonRolling(reasons, newReason, 1);
    expect(result).toHaveLength(0);
  });

  it("defaults to window size of 5", () => {
    const reasons = Array(10).fill("some reason");
    const result = checkDuplicateReasonRolling(reasons, "some reason");
    // Should find at least one exact match in the last 5
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Multiple Violations ─────────────────────────────────────────────────────────

describe("multiple violations", () => {
  it("returns multiple violations when new reason matches multiple previous reasons", () => {
    const result = checkDuplicateReason(
      [
        "exact duplicate text here for testing purposes",
        "some other reason that is different",
        "exact duplicate text here for testing purposes",
      ],
      "exact duplicate text here for testing purposes"
    );
    expect(result).toHaveLength(2);
  });

  it("sorts violations by severity (exact first, then case-insensitive, then fuzzy)", () => {
    const result = checkDuplicateReason(
      [
        "EXACT DUPLICATE TEXT HERE FOR TESTING PURPOSES",
        "exact duplicate text here for testing purposes",
        "exact duplicate text here for testing purpose",
      ],
      "exact duplicate text here for testing purposes"
    );
    // Index 1 is exact match, index 0 is case-insensitive, index 2 is fuzzy
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].matchType).toBe("exact");
    // The second should be case_insensitive (higher severity than fuzzy)
    expect(result[1].matchType).toBe("case_insensitive");
  });
});

// ─── maxDuplicatePenalty ─────────────────────────────────────────────────────────

describe("maxDuplicatePenalty", () => {
  it("returns 0 for empty violations array", () => {
    expect(maxDuplicatePenalty([])).toBe(0);
  });

  it("returns the penalty of a single violation", () => {
    const violations: DuplicateReasonViolation[] = [
      {
        reason: "test",
        originalIndex: 0,
        duplicateIndex: 1,
        matchType: "exact",
        similarity: 1.0,
        penalty: 25,
      },
    ];
    expect(maxDuplicatePenalty(violations)).toBe(25);
  });

  it("returns the highest penalty among multiple violations", () => {
    const violations: DuplicateReasonViolation[] = [
      {
        reason: "test",
        originalIndex: 0,
        duplicateIndex: 1,
        matchType: "fuzzy",
        similarity: 0.9,
        penalty: 15,
      },
      {
        reason: "test",
        originalIndex: 2,
        duplicateIndex: 1,
        matchType: "exact",
        similarity: 1.0,
        penalty: 25,
      },
    ];
    expect(maxDuplicatePenalty(violations)).toBe(25);
  });
});

// ─── formatDuplicateReason ───────────────────────────────────────────────────────

describe("formatDuplicateReason", () => {
  it("returns empty string for empty violations", () => {
    expect(formatDuplicateReason([])).toBe("");
  });

  it("formats a single violation", () => {
    const violations: DuplicateReasonViolation[] = [
      {
        reason: "test reason",
        originalIndex: 0,
        duplicateIndex: 1,
        matchType: "exact",
        similarity: 1.0,
        penalty: 25,
      },
    ];
    const result = formatDuplicateReason(violations);
    expect(result).toContain("exact match");
    expect(result).toContain("similarity=1.00");
  });

  it("formats multiple violations with count", () => {
    const violations: DuplicateReasonViolation[] = [
      {
        reason: "test reason",
        originalIndex: 0,
        duplicateIndex: 1,
        matchType: "exact",
        similarity: 1.0,
        penalty: 25,
      },
      {
        reason: "test reason",
        originalIndex: 2,
        duplicateIndex: 1,
        matchType: "fuzzy",
        similarity: 0.9,
        penalty: 15,
      },
    ];
    const result = formatDuplicateReason(violations);
    expect(result).toContain("exact match");
    expect(result).toContain("(and 1 other match)");
  });

  it("formats fuzzy match with similarity", () => {
    const violations: DuplicateReasonViolation[] = [
      {
        reason: "fuzzy reason",
        originalIndex: 0,
        duplicateIndex: 1,
        matchType: "fuzzy",
        similarity: 0.87,
        penalty: 15,
      },
    ];
    const result = formatDuplicateReason(violations);
    expect(result).toContain("fuzzy match");
    expect(result).toContain("similarity=0.87");
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles previousReasons containing empty strings", () => {
    const result = checkDuplicateReason(
      ["", "valid reason", ""],
      "valid reason"
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("exact");
  });

  it("handles previousReasons containing only whitespace", () => {
    const result = checkDuplicateReason(
      ["   ", "valid reason"],
      "valid reason"
    );
    expect(result).toHaveLength(1);
  });

  it("handles single-character strings (no false fuzzy match)", () => {
    const result = checkDuplicateReason(["a"], "a");
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("exact");
  });

  it("handles very long strings without crashing", () => {
    const longStr = "A".repeat(5000);
    const result = checkDuplicateReason([longStr], longStr);
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("exact");
  });

  it("handles unicode characters correctly", () => {
    const result = checkDuplicateReason(
      ["café résumé naïve"],
      "café résumé naïve"
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("exact");
  });

  it("handles unicode case-insensitive match", () => {
    const result = checkDuplicateReason(
      ["CAFÉ RÉSUMÉ"],
      "café résumé"
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("case_insensitive");
  });

  it("handles numbers and special characters", () => {
    const result = checkDuplicateReason(
      ["step 1: check port 8080 (timeout=30s)"],
      "step 1: check port 8080 (timeout=30s)"
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("exact");
  });

  it("truncates reason in violation to 200 chars", () => {
    const longReason = "X".repeat(500);
    const result = checkDuplicateReason([longReason], longReason);
    expect(result[0].reason.length).toBe(200);
  });
});

// ─── Integration: checkDuplicateReason with custom options ───────────────────────

describe("custom options", () => {
  it("respects shortStringMinLength option", () => {
    // Strings shorter than minLength should not fuzzy match
    const result = checkDuplicateReason(
      ["short but different"],
      "short but different!",
      { shortStringMinLength: 50 }
    );
    // Both strings are < 50 chars, so fuzzy is skipped
    expect(result).toHaveLength(0);
  });

  it("allows disabling both case-insensitive and fuzzy", () => {
    const result = checkDuplicateReason(
      ["SAME TEXT HERE FOR TESTING"],
      "same text here for testing",
      { enableCaseInsensitive: false, enableFuzzy: false }
    );
    expect(result).toHaveLength(0);
  });

  it("allows very low fuzzy threshold to catch moderate changes", () => {
    const result = checkDuplicateReason(
      ["The system configuration file needs to be updated for the new deployment"],
      "The system config file needs to be updated for the new deployment pipeline",
      { fuzzyThreshold: 0.7 }
    );
    expect(result).toHaveLength(1);
    expect(result[0].matchType).toBe("fuzzy");
  });
});
