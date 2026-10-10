import { describe, it, expect, vi } from "vitest";
import { CachingLlmClient, canonicalJson, KEY_PREFIX, newCounters } from "../llmCache.js";
import { MemoryBackend, RedisBackend, type CacheBackend, type RedisLike } from "../backends.js";
import { cacheConfigFromEnv } from "../index.js";
import type { LlmClient, LlmMessage, LlmResponse } from "../../core/types.js";

const msgs = (t: string): LlmMessage[] => [{ role: "system", content: "sys" }, { role: "user", content: t }];
const resp = (over: Partial<LlmResponse> = {}): LlmResponse => ({ content: "answer", toolCalls: [], finishReason: "stop", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }, ...over });

function inner(responses: LlmResponse[] | (() => LlmResponse)) {
  let n = 0;
  const complete = vi.fn(async () => (typeof responses === "function" ? responses() : responses[Math.min(n++, responses.length - 1)]));
  return { client: { complete } as unknown as LlmClient, complete };
}
const mk = (i: LlmClient, o: Partial<ConstructorParameters<typeof CachingLlmClient>[1]> = {}, backend: CacheBackend = new MemoryBackend()) =>
  new CachingLlmClient(i, { backend, fingerprint: () => ({ provider: "p", model: "m" }), defaultTemperature: 0, thinking: false, ttlSeconds: 60, ...o });

describe("CachingLlmClient", () => {
  it("second identical request is served from cache with zero token usage", async () => {
    const { client, complete } = inner([resp()]);
    const c = mk(client);
    const a = await c.complete(msgs("hi"));
    const b = await c.complete(msgs("hi"));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(b.content).toBe(a.content);
    expect(b.cacheHit).toBe(true); expect(a.cacheHit).toBeUndefined();
    expect(b.usage).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 100 });
    expect(c.stats()).toMatchObject({ hits: 1, misses: 1, stored: 1, tokensSaved: 120 });
  });

  it.each([
    ["different message", (c: CachingLlmClient) => c.complete(msgs("other"))],
    ["different model override", (c: CachingLlmClient) => c.complete(msgs("hi"), { model: "m2" })],
    ["different tools", (c: CachingLlmClient) => c.complete(msgs("hi"), { tools: [{ type: "function", function: { name: "t", description: "", parameters: {} } } as never] })],
    ["json mode", (c: CachingLlmClient) => c.complete(msgs("hi"), { responseFormat: "json_object" })],
  ])("misses on %s", async (_n, call) => {
    const { client, complete } = inner([resp()]);
    const c = mk(client);
    await c.complete(msgs("hi")); await call(c);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("different scope or different model fingerprint never share entries", async () => {
    const backend = new MemoryBackend(); const { client, complete } = inner([resp()]);
    await mk(client, { scope: "a" }, backend).complete(msgs("hi"));
    await mk(client, { scope: "b" }, backend).complete(msgs("hi"));
    await mk(client, { scope: "a", fingerprint: () => ({ provider: "p", model: "other" }) }, backend).complete(msgs("hi"));
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("clients created per request share process-wide counters and cache entries", async () => {
    const backend = new MemoryBackend(); const counters = newCounters(); const { client } = inner([resp()]);
    await mk(client, { counters }, backend).complete(msgs("hi"));       // request 1: its client is then discarded
    await mk(client, { counters }, backend).complete(msgs("hi"));       // request 2: new client, same backend
    expect(counters).toMatchObject({ misses: 1, stored: 1, hits: 1 });
  });

  it("key is stable regardless of property order", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [2, { y: 1, x: 2 }] } })).toBe(canonicalJson({ a: { c: [2, { x: 2, y: 1 }], d: 1 }, b: 1 }));
    const c = mk(inner([resp()]).client);
    expect(c.key([{ role: "user", content: "x" } as LlmMessage])).toMatch(new RegExp(`^${KEY_PREFIX}[0-9a-f]{64}$`));
  });

  it("never caches thinking mode or temperatures above the limit", async () => {
    const t = inner([resp()]); const think = mk(t.client, { thinking: true });
    await think.complete(msgs("hi")); await think.complete(msgs("hi"));
    expect(t.complete).toHaveBeenCalledTimes(2); expect(think.stats().bypassed).toBe(2);
    const w = inner([resp()]); const warm = mk(w.client);
    await warm.complete(msgs("hi"), { temperature: 0.7 }); await warm.complete(msgs("hi"), { temperature: 0.7 });
    expect(w.complete).toHaveBeenCalledTimes(2);
    const hot = inner([resp()]); const allowed = mk(hot.client, { maxTemperature: 0.7 });
    await allowed.complete(msgs("hi"), { temperature: 0.7 }); await allowed.complete(msgs("hi"), { temperature: 0.7 });
    expect(hot.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["truncated", resp({ finishReason: "length" })],
    ["content filtered", resp({ finishReason: "content_filter" })],
    ["empty", resp({ content: "  ", toolCalls: [] })],
  ])("does not store a %s answer", async (_n, r) => {
    const { client, complete } = inner([r]); const c = mk(client);
    await c.complete(msgs("hi")); await c.complete(msgs("hi"));
    expect(complete).toHaveBeenCalledTimes(2); expect(c.stats().stored).toBe(0);
  });

  it("caches a tool-call-only answer", async () => {
    const tc = resp({ content: "", finishReason: "tool_calls", toolCalls: [{ id: "1", type: "function", function: { name: "ls", arguments: "{}" } } as never] });
    const { client, complete } = inner([tc]); const c = mk(client);
    await c.complete(msgs("hi")); const b = await c.complete(msgs("hi"));
    expect(complete).toHaveBeenCalledTimes(1); expect(b.toolCalls).toHaveLength(1);
  });

  it("does not store oversized entries", async () => {
    const { client, complete } = inner([resp({ content: "x".repeat(2000) })]); const c = mk(client, { maxEntryBytes: 500 });
    await c.complete(msgs("hi")); await c.complete(msgs("hi"));
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("a corrupt cache entry is treated as a miss and overwritten", async () => {
    const backend = new MemoryBackend(); const { client, complete } = inner([resp()]); const c = mk(client, {}, backend);
    await backend.set(c.key(msgs("hi")), "{not json", 60);
    const r = await c.complete(msgs("hi"));
    expect(r.content).toBe("answer"); expect(complete).toHaveBeenCalledTimes(1);
    expect((await c.complete(msgs("hi"))).cacheHit).toBe(true);
  });

  it("a backend that throws never breaks the call (fail-open)", async () => {
    const bad: CacheBackend = { kind: "redis", get: async () => { throw new Error("boom"); }, set: async () => { throw new Error("boom"); }, clear: async () => 0, size: async () => null, isReady: () => false, close: async () => {} };
    const { client, complete } = inner([resp()]); const c = mk(client, {}, bad);
    expect((await c.complete(msgs("hi"))).content).toBe("answer"); expect(complete).toHaveBeenCalledTimes(1);
  });

  it("inner client errors propagate and are not cached", async () => {
    let fail = true; const complete = vi.fn(async () => { if (fail) throw new Error("llm down"); return resp(); });
    const c = mk({ complete } as unknown as LlmClient);
    await expect(c.complete(msgs("hi"))).rejects.toThrow("llm down");
    fail = false; expect((await c.complete(msgs("hi"))).content).toBe("answer");
  });
});

describe("MemoryBackend", () => {
  it("expires entries and evicts least-recently-used", async () => {
    let t = 0; const m = new MemoryBackend(2, () => t);
    await m.set("a", "1", 10); await m.set("b", "2", 10); await m.get("a"); await m.set("c", "3", 10);
    expect(await m.get("b")).toBeNull(); expect(await m.get("a")).toBe("1");
    t = 11_000; expect(await m.get("a")).toBeNull();
  });
  it("clear removes only the prefix", async () => {
    const m = new MemoryBackend(); await m.set("p:1", "x", 9); await m.set("p:2", "x", 9); await m.set("q:1", "x", 9);
    expect(await m.clear("p:")).toBe(2); expect(await m.size()).toBe(1);
  });
});

function fakeRedis(over: Partial<RedisLike> = {}): RedisLike & { calls: number } {
  const store = new Map<string, string>(); const r: any = {
    calls: 0, isReady: true,
    get: async (k: string) => { r.calls++; return store.get(k) ?? null; },
    set: async (k: string, v: string) => { r.calls++; store.set(k, v); return "OK"; },
    unlink: async (ks: string[]) => { let n = 0; for (const k of ks) if (store.delete(k)) n++; return n; },
    dbSize: async () => store.size,
    scanIterator: async function* () { yield [...store.keys()]; },
    quit: async () => {}, ...over,
  };
  return r;
}

describe("RedisBackend (fail-open)", () => {
  it("round-trips through the client", async () => {
    const b = new RedisBackend({ url: "redis://x", client: fakeRedis() });
    expect(await b.set("k", "v", 5)).toBe(true); expect(await b.get("k")).toBe("v"); expect(await b.size()).toBe(1);
  });
  it("returns null/false when not connected instead of throwing", async () => {
    const b = new RedisBackend({ url: "redis://x", client: fakeRedis({ isReady: false }) });
    expect(await b.get("k")).toBeNull(); expect(await b.set("k", "v", 5)).toBe(false); expect(b.isReady()).toBe(false);
  });
  it("times out a hung command", async () => {
    const b = new RedisBackend({ url: "redis://x", commandTimeoutMs: 20, client: fakeRedis({ get: () => new Promise(() => {}) }) });
    const t0 = Date.now(); expect(await b.get("k")).toBeNull(); expect(Date.now() - t0).toBeLessThan(500);
  });
  it("opens the circuit after repeated failures and stops calling Redis, then retries after the window", async () => {
    let now = 0; const r = fakeRedis({ get: async () => { r.calls++; throw new Error("down"); } });
    const b = new RedisBackend({ url: "redis://x", client: r, breakerThreshold: 3, breakerMs: 1000, now: () => now });
    for (let i = 0; i < 3; i++) await b.get("k");
    expect(r.calls).toBe(3); expect(b.isReady()).toBe(false);
    await b.get("k"); await b.get("k"); expect(r.calls).toBe(3);            // breaker open: no calls
    now = 1500; await b.get("k"); expect(r.calls).toBe(4);                   // half-open retry
  });
  it("clear unlinks every key under the prefix", async () => {
    const r = fakeRedis(); const b = new RedisBackend({ url: "redis://x", client: r });
    await b.set("xcoder:llm:v1:a", "1", 5); await b.set("xcoder:llm:v1:b", "1", 5);
    expect(await b.clear("xcoder:llm:v1:")).toBe(2); expect(await b.size()).toBe(0);
  });
});

describe("cacheConfigFromEnv", () => {
  it("is off by default and on automatically when a Redis URL is set", () => {
    expect(cacheConfigFromEnv({}).mode).toBe("off");
    expect(cacheConfigFromEnv({ XCODER_REDIS_URL: "redis://redis:6379" }).mode).toBe("redis");
  });
  it("XCODER_CACHE=off wins; =redis without a URL stays off; =memory works without Redis", () => {
    expect(cacheConfigFromEnv({ XCODER_CACHE: "off", XCODER_REDIS_URL: "redis://r" }).mode).toBe("off");
    expect(cacheConfigFromEnv({ XCODER_CACHE: "redis" }).mode).toBe("off");
    expect(cacheConfigFromEnv({ XCODER_CACHE: "memory" }).mode).toBe("memory");
  });
  it("sanitises numeric settings", () => {
    const c = cacheConfigFromEnv({ XCODER_REDIS_URL: "redis://r", XCODER_CACHE_TTL_SECONDS: "abc", XCODER_CACHE_MAX_TEMPERATURE: "-1" });
    expect(c.ttlSeconds).toBe(86_400); expect(c.maxTemperature).toBe(0);
    expect(cacheConfigFromEnv({ XCODER_REDIS_URL: "redis://r", XCODER_CACHE_TTL_SECONDS: "0" }).ttlSeconds).toBe(86_400);
  });
});
