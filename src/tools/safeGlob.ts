/**
 * Guard for model/user-supplied glob patterns before they reach fast-glob.
 *
 * fast-glob -> micromatch -> braces <=3.0.3 has a stack-exhaustion DoS on deeply nested brace
 * patterns (npm audit: no upstream fix available). Patterns reach us from the LLM, i.e.
 * indirectly from any authenticated user, so reject pathological ones instead of letting one
 * request wedge the shared server process. Real-world globs are short and nest braces at most
 * a couple of levels.
 */
export const MAX_GLOB_LENGTH = 512;
export const MAX_BRACE_DEPTH = 5;

export function assertSafeGlob(pattern: string): string {
  if (typeof pattern !== "string") throw new Error("Glob pattern must be a string");
  if (pattern.length > MAX_GLOB_LENGTH) {
    throw new Error(`Glob pattern too long (max ${MAX_GLOB_LENGTH} characters)`);
  }
  let depth = 0;
  for (const ch of pattern) {
    if (ch === "{") {
      depth++;
      if (depth > MAX_BRACE_DEPTH) throw new Error(`Glob pattern nests braces too deeply (max ${MAX_BRACE_DEPTH})`);
    } else if (ch === "}" && depth > 0) depth--;
  }
  return pattern;
}
