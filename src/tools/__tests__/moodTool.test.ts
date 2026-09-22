/**
 * Tests for set_mood_tool: the pure store/logic in moodTool.ts, its schema registration, and
 * the real dispatch path through toolDispatcher.ts (mirrors securityOpsTool.dispatcher.test.ts's
 * approach of exercising dispatchToolCall directly rather than mocking the tool underneath it).
 */
import { describe, it, expect } from "vitest";
import { dispatchToolCall } from "../toolDispatcher.js";
import { TOOL_SCHEMAS } from "../toolSchemas.js";
import { getMood, setMood, runSetMoodTool, isJarvisMood, JARVIS_MOODS } from "../moodTool.js";
import type { ToolCall } from "../../core/types.js";

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: "t1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

describe("set_mood_tool schema", () => {
  it("is registered in TOOL_SCHEMAS with a mood enum of exactly the six moods", () => {
    const schema = TOOL_SCHEMAS.find((s) => s.function.name === "set_mood_tool");
    expect(schema).toBeDefined();
    expect(schema!.function.parameters.required).toEqual(["mood"]);
    const moodProp = schema!.function.parameters.properties.mood as { enum?: string[] };
    expect(moodProp.enum).toEqual(expect.arrayContaining(JARVIS_MOODS));
    expect(moodProp.enum).toHaveLength(JARVIS_MOODS.length);
  });
});

describe("moodTool.ts store", () => {
  it("isJarvisMood accepts only the six known moods", () => {
    for (const m of JARVIS_MOODS) expect(isJarvisMood(m)).toBe(true);
    expect(isJarvisMood("furious")).toBe(false);
    expect(isJarvisMood(42)).toBe(false);
    expect(isJarvisMood(undefined)).toBe(false);
  });

  it("getMood picks and caches a random mood on first access for a fresh workspace", () => {
    const cwd = `/tmp/mood-test-${Math.random()}`;
    const first = getMood(cwd);
    expect(JARVIS_MOODS).toContain(first);
    // Cached, not re-rolled — repeated reads return the same value.
    expect(getMood(cwd)).toBe(first);
    expect(getMood(cwd)).toBe(first);
  });

  it("setMood persists until changed again — it does not reset between reads", () => {
    const cwd = `/tmp/mood-test-${Math.random()}`;
    setMood(cwd, "attack");
    expect(getMood(cwd)).toBe("attack");
    expect(getMood(cwd)).toBe("attack");
    setMood(cwd, "ready");
    expect(getMood(cwd)).toBe("ready");
  });

  it("mood is scoped per workspace (cwd) — unrelated workspaces don't see each other's mood", () => {
    const cwdA = `/tmp/mood-test-a-${Math.random()}`;
    const cwdB = `/tmp/mood-test-b-${Math.random()}`;
    setMood(cwdA, "danger");
    setMood(cwdB, "happy");
    expect(getMood(cwdA)).toBe("danger");
    expect(getMood(cwdB)).toBe("happy");
  });

  it("runSetMoodTool accepts a valid mood as-is", () => {
    const { mood, wasValid } = runSetMoodTool(`/tmp/mood-test-${Math.random()}`, "sad");
    expect(mood).toBe("sad");
    expect(wasValid).toBe(true);
  });

  it("runSetMoodTool falls back to a random mood — rather than erroring — for an invalid mood", () => {
    const { mood, wasValid } = runSetMoodTool(`/tmp/mood-test-${Math.random()}`, "furious");
    expect(JARVIS_MOODS).toContain(mood);
    expect(wasValid).toBe(false);
  });

  it("runSetMoodTool carries the optional reason through untouched", () => {
    const { reason } = runSetMoodTool(`/tmp/mood-test-${Math.random()}`, "happy", "task completed cleanly");
    expect(reason).toBe("task completed cleanly");
  });
});

describe("set_mood_tool dispatch", () => {
  it("routes a valid mood through to the store and reports success", async () => {
    const cwd = `/tmp/mood-dispatch-${Math.random()}`;
    const result = await dispatchToolCall(call("set_mood_tool", { mood: "alert", reason: "unusual activity" }), cwd);
    expect(result.isError).toBe(false);
    const obs = result.observation as { status: string; mood: string; reason: string | null };
    expect(obs.status).toBe("success");
    expect(obs.mood).toBe("alert");
    expect(obs.reason).toBe("unusual activity");
    expect(getMood(cwd)).toBe("alert");
  });

  it("persists across separate dispatch calls in the same workspace until called again", async () => {
    const cwd = `/tmp/mood-dispatch-${Math.random()}`;
    await dispatchToolCall(call("set_mood_tool", { mood: "danger" }), cwd);
    // A different, unrelated tool call in between shouldn't reset it.
    await dispatchToolCall(call("glob_tool", { pattern: "*.ts" }), cwd);
    expect(getMood(cwd)).toBe("danger");
    await dispatchToolCall(call("set_mood_tool", { mood: "happy" }), cwd);
    expect(getMood(cwd)).toBe("happy");
  });

  it("rejects a call missing the required 'mood' argument before running the tool", async () => {
    const result = await dispatchToolCall(call("set_mood_tool", {}), `/tmp/mood-dispatch-${Math.random()}`);
    expect(result.isError).toBe(true);
    expect((result.observation as { error: string }).error).toMatch(/Missing required argument/);
  });

  it("falls back to a random mood, rather than erroring, when given an unknown mood string", async () => {
    const cwd = `/tmp/mood-dispatch-${Math.random()}`;
    const result = await dispatchToolCall(call("set_mood_tool", { mood: "furious" }), cwd);
    expect(result.isError).toBe(false);
    const obs = result.observation as { status: string; mood: string; message: string };
    expect(obs.status).toBe("success");
    expect(JARVIS_MOODS).toContain(obs.mood);
    expect(obs.message).toMatch(/isn't one of the six known moods/);
    expect(getMood(cwd)).toBe(obs.mood);
  });
});
