import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { RedisBackend } from "../backends.js";
import { CachingLlmClient, KEY_PREFIX } from "../llmCache.js";

const PORT = 6391; let proc: ChildProcess | undefined;
const start = () => { proc = spawn("redis-server", ["--port", String(PORT), "--requirepass", "s3cretpass", "--save", "", "--appendonly", "no", "--bind", "127.0.0.1"], { stdio: "ignore" }); };
const stop = async () => { proc?.kill("SIGKILL"); proc = undefined; await new Promise((r) => setTimeout(r, 300)); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterAll(stop);

// Needs a local redis-server binary (skipped otherwise). Uses its own port and password.
const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;
describe.skipIf(!hasRedis)("real redis", () => {
  it("auth, caching, outage fail-open, reconnect, clear", async () => {
    start(); await sleep(600);
    const bad = new RedisBackend({ url: `redis://127.0.0.1:${PORT}`, password: "wrong" }); await sleep(500);
    expect(bad.isReady()).toBe(false); expect(await bad.get("x")).toBeNull();      // wrong password: no cache, no throw
    await bad.close();

    const backend = new RedisBackend({ url: `redis://127.0.0.1:${PORT}`, password: "s3cretpass", breakerMs: 400 }); await sleep(500);
    expect(backend.isReady()).toBe(true);
    let calls = 0; const inner = { complete: async () => { calls++; return { content: "hello", toolCalls: [], finishReason: "stop", usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } }; } };
    const c = new CachingLlmClient(inner as never, { backend, fingerprint: () => ({ m: 1 }), defaultTemperature: 0, thinking: false, ttlSeconds: 30 });
    const m = [{ role: "user", content: "q" }] as never;
    await c.complete(m); const hit = await c.complete(m);
    expect(calls).toBe(1); expect(hit.cacheHit).toBe(true);
    expect(await backend.size()).toBe(1);

    await stop();                                                                  // Redis dies mid-flight
    const t0 = Date.now(); const r = await c.complete(m);
    expect(r.content).toBe("hello"); expect(calls).toBe(2); expect(Date.now() - t0).toBeLessThan(1500);   // still answers, promptly

    start(); await sleep(2500);                                                    // Redis returns; client reconnects by itself
    await c.complete(m); await c.complete(m);
    expect((await c.complete(m)).cacheHit).toBe(true);
    expect(await backend.clear(KEY_PREFIX)).toBeGreaterThanOrEqual(1); expect(await backend.size()).toBe(0);
    await backend.close();
  }, 30_000);
});
