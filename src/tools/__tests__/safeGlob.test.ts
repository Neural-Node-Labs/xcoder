import { describe, it, expect } from "vitest";
import { assertSafeGlob, MAX_GLOB_LENGTH, MAX_BRACE_DEPTH } from "../safeGlob.js";

describe("assertSafeGlob", () => {
  it("accepts ordinary patterns", () => {
    for (const p of ["**/*", "src/**/*.{ts,tsx}", "**/*.{ts,{js,mjs}}"]) expect(assertSafeGlob(p)).toBe(p);
  });
  it("rejects over-long patterns", () => {
    expect(() => assertSafeGlob("a".repeat(MAX_GLOB_LENGTH + 1))).toThrow(/too long/);
  });
  it("rejects deeply nested braces", () => {
    expect(() => assertSafeGlob("{".repeat(MAX_BRACE_DEPTH + 1) + "a,b" + "}".repeat(MAX_BRACE_DEPTH + 1))).toThrow(/too deeply/);
  });
  it("rejects non-strings", () => {
    expect(() => assertSafeGlob(undefined as unknown as string)).toThrow();
  });
});
