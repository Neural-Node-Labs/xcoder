// @vitest-environment jsdom
// .tsx on purpose: the root vitest run only globs *.test.ts (it has no jsdom); anything importing
// api/client.ts (localStorage at module load) belongs to ui's own jsdom runner, like keepAlive.test.tsx.
import { describe, it, expect, vi, afterEach } from "vitest";
import { applyAgiEvent, isSpanEvent, MAX_SPANS, type SpanMap } from "../agiEvents";
import { spanLabel } from "../AgiActivity";
import { kpiGap } from "../AgiGoal";
import { api } from "../../../api/client";

const start = (id: string, extra: Record<string, unknown> = {}) => ({ kind: "span", id, name: "agi.run", phase: "start", t: 100, attrs: { "agi.mode": "chat", "agi.message": "hi" }, ...extra });
const end = (id: string, extra: Record<string, unknown> = {}) => ({ kind: "span", id, name: "agi.run", phase: "end", t: 180, ms: 80, attrs: { x: 1 }, ...extra });

describe("applyAgiEvent", () => {
  it("opens a span on start and completes it on end, merging attrs", () => {
    let m: SpanMap = applyAgiEvent({}, start("a"));
    expect(m.a).toMatchObject({ done: false, start: 100 });
    m = applyAgiEvent(m, end("a"));
    expect(m.a).toMatchObject({ done: true, ms: 80 });
    expect(m.a.attrs).toMatchObject({ "agi.mode": "chat", x: 1 });
  });
  it("tolerates an end without a start (reconnect mid-span)", () => {
    const m = applyAgiEvent({}, end("z", { parent: "p" }));
    expect(m.z).toMatchObject({ done: true, parent: "p", start: 100 });
  });
  it("records errors and events", () => {
    const m = applyAgiEvent(applyAgiEvent({}, start("a")), end("a", { error: "boom", events: [{ name: "policy", attrs: { verdict: "deny" } }] }));
    expect(m.a.error).toBe("boom");
    expect(m.a.events?.[0].attrs.verdict).toBe("deny");
  });
  it("ignores non-span and malformed events, returning the same map", () => {
    const prev: SpanMap = {};
    for (const bad of [null, undefined, 5, "x", {}, { kind: "goal" }, { kind: "span" }, { kind: "span", id: 3, name: "n" }]) expect(applyAgiEvent(prev, bad)).toBe(prev);
  });
  it("bounds memory by evicting the oldest spans", () => {
    let m: SpanMap = {};
    for (let i = 0; i < MAX_SPANS + 25; i++) m = applyAgiEvent(m, start(`s${i}`, { t: i }));
    expect(Object.keys(m)).toHaveLength(MAX_SPANS);
    expect(m.s0).toBeUndefined();
    expect(m[`s${MAX_SPANS + 24}`]).toBeDefined();
  });
  it("isSpanEvent discriminates", () => {
    expect(isSpanEvent(start("a"))).toBe(true);
    expect(isSpanEvent({ kind: "approval" })).toBe(false);
    expect(isSpanEvent(null)).toBe(false);
  });
});

describe("labels and KPI gap", () => {
  it("labels known spans and truncates untrusted attrs", () => {
    const s = (name: string, attrs: Record<string, unknown>) => ({ id: "i", name, attrs, start: 0, done: true });
    expect(spanLabel(s("agi.tool", { "tool.name": "bash", "tool.args": "ls" }))).toBe("tool bash ls");
    expect(spanLabel(s("agi.verify", { "verify.pass": false }))).toBe("verify → FAIL");
    expect(spanLabel(s("agi.verify", {}))).toBe("verify → …");
    expect(spanLabel(s("agi.run", { "agi.mode": "chat", "agi.message": "x".repeat(500) })).length).toBeLessThan(120);
    expect(spanLabel(s("something.else", {}))).toBe("something.else");
  });
  it("computes KPI gaps for max/min directions and unmeasured KPIs", () => {
    expect(kpiGap({ name: "a", direction: "max", target: 1, suite: "g" })).toBeNull();
    expect(kpiGap({ name: "a", direction: "max", target: 1, current: 0.5, suite: "g" })).toBe(0.5);
    expect(kpiGap({ name: "a", direction: "max", target: 1, current: 1, suite: "g" })).toBe(0);
    expect(kpiGap({ name: "a", direction: "min", target: 6, current: 5, suite: "g" })).toBe(0);
    expect(kpiGap({ name: "a", direction: "min", target: 6, current: 9, suite: "g" })).toBe(1);
  });
});

describe("api.agiStream (SSE over fetch)", () => {
  afterEach(() => vi.restoreAllMocks());
  const streamOf = (chunks: string[], ok = true, status = 200) => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
    return { ok, status, body } as unknown as Response;
  };

  it("reassembles frames split across chunks, skips keep-alives and garbage, never dies on bad JSON", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(streamOf([': ka\n\ndata: {"kind":"span","id":"a"', ',"name":"n"}\n\nda', 'ta: not json\n\ndata: {"kind":"goal"}\n\n']));
    const seen: unknown[] = [];
    const opened = vi.fn();
    await api.agiStream((e) => seen.push(e), new AbortController().signal, opened);
    expect(seen).toEqual([{ kind: "span", id: "a", name: "n" }, { kind: "goal" }]);
    expect(opened).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/agi/events");
    expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
  });
  it("throws when the gateway refuses (e.g. non-admin 403 / not configured 503)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(streamOf([], false, 403));
    await expect(api.agiStream(() => {}, new AbortController().signal)).rejects.toThrow(/HTTP 403/);
  });
});
