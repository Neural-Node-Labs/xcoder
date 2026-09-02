import { describe, it, expect } from "vitest";

// Replicate the repair functions here for testing
function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to repair path
  }

  const repaired = attemptJsonRepair(raw);
  if (repaired !== null) {
    return repaired;
  }

  throw new Error(`Failed to parse or repair JSON object from input: ${raw}`);
}

function attemptJsonRepair(raw: string): Record<string, unknown> | null {
  if (!raw || raw.length < 2) return null;

  let repaired = raw;

  // Repair 1: Fix unescaped double quotes inside string values
  repaired = repairUnescapedQuotes(repaired);

  // Repair 2: Fix truncated strings (missing closing quote at end)
  repaired = repairTruncatedString(repaired);

  // Repair 3: Fix missing closing braces/brackets
  repaired = repairMissingClosers(repaired);

  try {
    const result = JSON.parse(repaired);
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function repairUnescapedQuotes(raw: string): string {
  const chars: string[] = [];
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (escapeNext) {
      chars.push(c);
      escapeNext = false;
      continue;
    }

    if (c === "\\") {
      chars.push(c);
      escapeNext = true;
      continue;
    }

    if (c === '"') {
      if (inString) {
        const rest = raw.slice(i + 1).trimStart();
        if (rest.length === 0 || rest[0] === "," || rest[0] === "]" || rest[0] === "}" || rest[0] === ":") {
          chars.push(c);
          inString = false;
        } else {
          chars.push("\\");
          chars.push(c);
        }
      } else {
        chars.push(c);
        inString = true;
      }
      continue;
    }

    chars.push(c);
  }

  return chars.join("");
}

function repairTruncatedString(raw: string): string {
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (c === "\\") {
      escapeNext = true;
      continue;
    }

    if (c === '"') {
      inString = !inString;
    }
  }

  if (inString) {
    return raw + '"';
  }

  return raw;
}

function repairMissingClosers(raw: string): string {
  let inString = false;
  let escapeNext = false;
  const stack: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (c === "\\") {
      escapeNext = true;
      continue;
    }

    if (c === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (c === "{") {
      stack.push("}");
    } else if (c === "[") {
      stack.push("]");
    } else if (c === "}" || c === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === c) {
        stack.pop();
      }
    }
  }

  if (stack.length > 0) {
    return raw + stack.reverse().join("");
  }

  return raw;
}

describe("safeParseJson", () => {
  // --- Well-formed JSON (fast path) ---

  it("parses well-formed JSON normally", () => {
    const result = safeParseJson('{"filePath":"test.txt","mode":"write","content":"hello"}');
    expect(result).toEqual({ filePath: "test.txt", mode: "write", content: "hello" });
  });

  it("parses empty object", () => {
    const result = safeParseJson("{}");
    expect(result).toEqual({});
  });

  // --- Unescaped double quotes (the primary bug) ---

  it("repairs unescaped double quote in content value", () => {
    // Simulates: content contains an unescaped double quote like `const x = "hello";`
    const malformed = '{"filePath":"test.ts","mode":"write","content":"const x = "hello";"}';
    const result = safeParseJson(malformed);
    expect(result).toBeDefined();
    expect(result.filePath).toBe("test.ts");
    expect(result.mode).toBe("write");
    expect(result.content).toBe('const x = "hello";');
  });

  it("repairs multiple unescaped double quotes in content", () => {
    // Simulates source code with multiple double quotes
    const malformed = '{"filePath":"test.ts","content":"function foo() { return "bar" + "baz"; }"}';
    const result = safeParseJson(malformed);
    expect(result).toBeDefined();
    expect(result.filePath).toBe("test.ts");
    expect(result.content).toBe('function foo() { return "bar" + "baz"; }');
  });

  it("repairs unescaped quotes in deeply nested content", () => {
    // Simulates a write_edit_tool call with source code containing quotes
    const malformed = '{"filePath":"src/example.ts","mode":"edit","oldStr":"const msg = "hello world";","newStr":"const msg = "goodbye";"}';
    const result = safeParseJson(malformed);
    expect(result).toBeDefined();
    expect(result.filePath).toBe("src/example.ts");
    expect(result.mode).toBe("edit");
    expect(result.oldStr).toBe('const msg = "hello world";');
    expect(result.newStr).toBe('const msg = "goodbye";');
  });

  it("repairs unescaped quotes near the end of the JSON (position ~13827 scenario)", () => {
    // Build a large JSON payload with an unescaped quote near the end,
    // simulating the exact bug scenario (position 13827)
    const longContent = "A".repeat(13800) + 'const x = "hello";';
    const malformed = '{"filePath":"test.txt","mode":"write","content":"' + longContent + '"}';
    const result = safeParseJson(malformed);
    expect(result).toBeDefined();
    expect(result.filePath).toBe("test.txt");
    expect(result.mode).toBe("write");
    expect(result.content).toBe(longContent);
  });

  // --- Truncated strings ---

  it("repairs truncated string at end of JSON", () => {
    const malformed = '{"filePath":"test.txt","mode":"write","content":"hello';
    const result = safeParseJson(malformed);
    expect(result).toBeDefined();
    expect(result.filePath).toBe("test.txt");
    expect(result.mode).toBe("write");
    expect(result.content).toBe("hello");
  });

  // --- Missing closing braces ---

  it("repairs missing closing brace", () => {
    const malformed = '{"filePath":"test.txt","mode":"write"';
    const result = safeParseJson(malformed);
    expect(result).toBeDefined();
    expect(result.filePath).toBe("test.txt");
    expect(result.mode).toBe("write");
  });

  it("repairs missing closing braces with nested objects", () => {
    const malformed = '{"outer":{"inner":"value"';
    const result = safeParseJson(malformed);
    expect(result).toBeDefined();
    const outer = result.outer as Record<string, unknown>;
    expect(outer.inner).toBe("value");
  });

  // --- Edge cases ---

  it("throws on empty string", () => {
    expect(() => safeParseJson("")).toThrow();
  });

  it("throws on null-like input", () => {
    expect(() => safeParseJson("null")).toThrow();
  });

  it("preserves already-escaped quotes", () => {
    const valid = '{"content":"line 1\\nconst x = \\"hello\\";\\nline 2"}';
    const result = safeParseJson(valid);
    expect(result).toBeDefined();
    expect(result.content).toBe('line 1\nconst x = "hello";\nline 2');
  });

  it("handles JSON with arrays", () => {
    const malformed = '{"items":["item1","item2 with "quote" inside","item3"]}';
    const result = safeParseJson(malformed);
    expect(result).toBeDefined();
    const items = result.items as string[];
    expect(items[0]).toBe("item1");
    expect(items[1]).toBe('item2 with "quote" inside');
    expect(items[2]).toBe("item3");
  });

  it("handles JSON with escaped backslashes before quotes", () => {
    const valid = '{"content":"path\\\\to\\\\file"}';
    const result = safeParseJson(valid);
    expect(result).toBeDefined();
    expect(result.content).toBe("path\\to\\file");
  });
});
