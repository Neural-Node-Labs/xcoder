/**
 * iterationReasonDedup.ts — Duplicate iteration reason detection.
 *
 * Detects when the LLM produces a reasoning/thought that is substantively the same
 * as a previous iteration's reasoning within the same ReAct loop. This catches the
 * pattern where the model re-states the same plan, re-analyzes the same observations,
 * or re-describes the same approach without making forward progress.
 *
 * Three-pass matching strategy:
 *   1. **Exact match** — identical string (trimmed)
 *   2. **Case-insensitive match** — same text ignoring case
 *   3. **Fuzzy match** — Levenshtein-based similarity above a configurable threshold
 *      (default 0.85), with a short-string guard (strings < 20 chars require exact match)
 *
 * Each match type carries a different penalty weight:
 *   - Exact: -25 health score
 *   - Case-insensitive: -20 health score
 *   - Fuzzy: -15 health score
 *
 * Integration points:
 *   - stepScorer.ts: called alongside duplicateActionDetector to penalize repeated reasoning
 *     via the optional `thought` parameter on `scoreStep()`
 *   - orchestrator.ts: feeds into the self-healing nudge threshold
 *   - liveDiagnostics.ts: diagnostic #3 extended to also check for duplicate reasoning
 *
 * ⚠️ STATUS NOTE: The `thought` parameter is NOT currently passed by any of the three
 * call sites (orchestrator.ts, LeanEngine.ts, SwarmEngine.ts).
 * The duplicate iteration reason check is therefore dormant in production — it only
 * runs in unit tests. To activate it, each call site must extract the LLM's thought
 * from the current ReAct step and pass it as `thought` to `scoreStep()`.
 */

// ─── Types ────────────────────────────────────────────────────────────────────────

export interface DuplicateReasonViolation {
  /** The duplicate reason text. */
  reason: string;
  /** The iteration index of the original occurrence (0-based). */
  originalIndex: number;
  /** The iteration index of the duplicate occurrence (0-based). */
  duplicateIndex: number;
  /** Which matching pass caught it. */
  matchType: "exact" | "case_insensitive" | "fuzzy";
  /** Similarity score (0.0-1.0) for fuzzy matches; 1.0 for exact/case-insensitive. */
  similarity: number;
  /** Health score penalty for this violation. */
  penalty: number;
}

export interface IterationReasonDedupOptions {
  /** Similarity threshold for fuzzy matching (0.0-1.0). Default: 0.85. */
  fuzzyThreshold?: number;
  /** Minimum string length for fuzzy matching; shorter strings require exact match. Default: 20. */
  shortStringMinLength?: number;
  /** Whether to enable case-insensitive matching. Default: true. */
  enableCaseInsensitive?: boolean;
  /** Whether to enable fuzzy matching. Default: true. */
  enableFuzzy?: boolean;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS: Required<IterationReasonDedupOptions> = {
  fuzzyThreshold: 0.85,
  shortStringMinLength: 20,
  enableCaseInsensitive: true,
  enableFuzzy: true,
};

// ─── Penalty weights ──────────────────────────────────────────────────────────────

const PENALTIES = {
  exact: 25,
  case_insensitive: 20,
  fuzzy: 15,
} as const;

// ─── Public API ───────────────────────────────────────────────────────────────────

/**
 * Check a new iteration reason against all previous reasons in the list.
 * Returns any duplicate violations found, ordered by severity (exact first).
 *
 * @param previousReasons - All reasons from prior iterations (chronological order).
 * @param newReason - The current iteration's reason/thought text.
 * @param options - Optional configuration overrides.
 * @returns Array of violations (empty if no duplicates detected).
 */
export function checkDuplicateReason(
  previousReasons: string[],
  newReason: string,
  options?: IterationReasonDedupOptions
): DuplicateReasonViolation[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const trimmedNew = newReason.trim();
  if (!trimmedNew) return [];

  const violations: DuplicateReasonViolation[] = [];

  for (let i = 0; i < previousReasons.length; i++) {
    const prev = previousReasons[i].trim();
    if (!prev) continue;

    // Pass 1: Exact match
    if (trimmedNew === prev) {
      violations.push({
        reason: trimmedNew.slice(0, 200),
        originalIndex: i,
        duplicateIndex: previousReasons.length,
        matchType: "exact",
        similarity: 1.0,
        penalty: PENALTIES.exact,
      });
      continue; // No need to check weaker matches if exact already matched
    }

    // Pass 2: Case-insensitive match
    if (opts.enableCaseInsensitive && trimmedNew.toLowerCase() === prev.toLowerCase()) {
      violations.push({
        reason: trimmedNew.slice(0, 200),
        originalIndex: i,
        duplicateIndex: previousReasons.length,
        matchType: "case_insensitive",
        similarity: 1.0,
        penalty: PENALTIES.case_insensitive,
      });
      continue;
    }

    // Pass 3: Fuzzy match (Levenshtein-based)
    if (opts.enableFuzzy) {
      // Short-string guard: strings shorter than minLength require exact match (already checked above)
      if (trimmedNew.length < opts.shortStringMinLength || prev.length < opts.shortStringMinLength) {
        continue;
      }

      const similarity = levenshteinSimilarity(trimmedNew, prev);
      if (similarity >= opts.fuzzyThreshold) {
        violations.push({
          reason: trimmedNew.slice(0, 200),
          originalIndex: i,
          duplicateIndex: previousReasons.length,
          matchType: "fuzzy",
          similarity,
          penalty: PENALTIES.fuzzy,
        });
        // Don't break — continue checking for higher-severity matches against other entries
      }
    }
  }

  // Sort by severity: exact first, then case-insensitive, then fuzzy
  violations.sort((a, b) => {
    const order = ["exact", "case_insensitive", "fuzzy"];
    return order.indexOf(a.matchType) - order.indexOf(b.matchType);
  });

  return violations;
}

/**
 * Compute the maximum penalty from a set of violations.
 * When multiple violations exist for the same reason, the highest penalty wins.
 */
export function maxDuplicatePenalty(violations: DuplicateReasonViolation[]): number {
  if (violations.length === 0) return 0;
  return Math.max(...violations.map((v) => v.penalty));
}

/**
 * Build a human-readable reason string from violations, for inclusion in step scores.
 */
export function formatDuplicateReason(violations: DuplicateReasonViolation[]): string {
  if (violations.length === 0) return "";
  const primary = violations[0];
  const count = violations.length;
  const extra = count > 1 ? ` (and ${count - 1} other match${count > 2 ? "es" : ""})` : "";
  return `iteration reason repeats earlier reasoning (${primary.matchType} match, similarity=${primary.similarity.toFixed(2)})${extra}`;
}

// ─── Levenshtein Similarity ───────────────────────────────────────────────────────

/**
 * Compute Levenshtein (edit distance) similarity between two strings.
 * Returns a value in [0.0, 1.0] where 1.0 = identical.
 *
 * Uses the standard Wagner-Fischer algorithm with O(min(m,n)) space.
 */
function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  // Ensure b is the shorter string for O(min(m,n)) space
  if (a.length < b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Use two rows for O(n) space
  let prevRow: number[] = [];
  let currRow: number[] = [];

  for (let j = 0; j <= n; j++) {
    prevRow.push(j);
  }

  for (let i = 1; i <= m; i++) {
    currRow = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow.push(Math.min(
        prevRow[j] + 1,       // deletion
        currRow[j - 1] + 1,   // insertion
        prevRow[j - 1] + cost // substitution
      ));
    }
    prevRow = currRow;
  }

  const distance = prevRow[n];
  const maxLen = Math.max(m, n);
  return 1.0 - distance / maxLen;
}

// ─── Convenience: check against a rolling window ──────────────────────────────────

/**
 * Check a new reason against only the last N reasons (rolling window).
 * Useful for catching recent repetition without flagging old, legitimately similar
 * reasoning from earlier in a long task.
 *
 * @param previousReasons - All prior reasons (chronological order).
 * @param newReason - The current reason.
 * @param windowSize - How many recent reasons to check against. Default: 5.
 * @param options - Optional configuration overrides.
 */
export function checkDuplicateReasonRolling(
  previousReasons: string[],
  newReason: string,
  windowSize = 5,
  options?: IterationReasonDedupOptions
): DuplicateReasonViolation[] {
  const recent = previousReasons.slice(-windowSize);
  return checkDuplicateReason(recent, newReason, options);
}
