import { createHash } from "node:crypto";
import { createClient } from "redis";

/**
 * Cache storage. Everything here is FAIL-OPEN: a backend problem (Redis down, slow, wrong password, full) must
 * degrade to "no cache", never to an error in a chat or task. So no method rejects, and each Redis command has a
 * hard timeout plus a circuit breaker that stops calling a dead server for a while.
 */
export interface CacheBackend {
  readonly kind: "redis" | "memory";
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /** Delete every key under `prefix`; returns how many were removed. */
  clear(prefix: string): Promise<number>;
  /** Approximate number of entries, or null if unknown/unavailable. */
  size(): Promise<number | null>;
  isReady(): boolean;
  close(): Promise<void>;
}

// ─── in-process LRU (opt-in: XCODER_CACHE=memory, and used by tests) ───────────────────────────
export class MemoryBackend implements CacheBackend {
  readonly kind = "memory" as const;
  private m = new Map<string, { v: string; exp: number }>();
  constructor(private maxEntries = 500, private now: () => number = Date.now) {}
  async get(key: string) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp <= this.now()) { this.m.delete(key); return null; }
    this.m.delete(key); this.m.set(key, e);          // refresh recency
    return e.v;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    this.m.delete(key);
    this.m.set(key, { v: value, exp: this.now() + ttlSeconds * 1000 });
    while (this.m.size > this.maxEntries) this.m.delete(this.m.keys().next().value as string);
    return true;
  }
  async clear(prefix: string) {
    let n = 0;
    for (const k of [...this.m.keys()]) if (k.startsWith(prefix)) { this.m.delete(k); n++; }
    return n;
  }
  async size() { return this.m.size; }
  isReady() { return true; }
  async close() { this.m.clear(); }
}

// ─── Redis ──────────────────────────────────────────────────────────────────────────────
export interface RedisBackendOptions {
  url: string;
  password?: string;
  commandTimeoutMs?: number;
  /** After this many consecutive failures stop calling Redis for `breakerMs`. */
  breakerThreshold?: number;
  breakerMs?: number;
  now?: () => number;
  /** Test seam: supply a ready-made client instead of connecting. */
  client?: RedisLike;
}
/** The slice of node-redis we use (lets tests inject a fake and keeps the surface small). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
  unlink(keys: string[]): Promise<number>;
  dbSize(): Promise<number>;
  scanIterator(opts: { MATCH: string; COUNT: number }): AsyncIterable<string | string[]>;
  quit(): Promise<unknown>;
  isReady: boolean;
  connect?(): Promise<unknown>;
  on?(ev: "error", cb: (e: Error) => void): unknown;
  destroy?(): void;
}

/** Strip credentials so a URL can be logged. */
export const redactUrl = (u: string) => { try { const x = new URL(u); x.username = ""; x.password = ""; return x.toString(); } catch { return "<invalid url>"; } };

export class RedisBackend implements CacheBackend {
  readonly kind = "redis" as const;
  private c: RedisLike;
  private fails = 0;
  private openUntil = 0;
  private timeoutMs: number;
  private threshold: number;
  private breakerMs: number;
  private now: () => number;
  private loggedDown = false;

  constructor(o: RedisBackendOptions) {
    this.timeoutMs = o.commandTimeoutMs ?? 300;
    this.threshold = o.breakerThreshold ?? 3;
    this.breakerMs = o.breakerMs ?? 30_000;
    this.now = o.now ?? Date.now;
    if (o.client) { this.c = o.client; return; }
    const client = createClient({
      url: o.url,
      ...(o.password ? { password: o.password } : {}),
      disableOfflineQueue: true,                       // fail fast while disconnected instead of queueing prompts in memory
      socket: { connectTimeout: 2_000, reconnectStrategy: (n: number) => Math.min(200 * 2 ** Math.min(n, 6), 10_000) },
    });
    client.on("error", (e: Error) => { if (!this.loggedDown) { this.loggedDown = true; console.warn(`[cache] redis unavailable (${redactUrl(o.url)}): ${e.message} — continuing without cache`); } });
    client.on("ready", () => { if (this.loggedDown) console.log("[cache] redis reconnected"); this.loggedDown = false; });
    this.c = client as unknown as RedisLike;
    void client.connect().catch(() => { /* reported by the error handler; reconnectStrategy keeps trying */ });
  }

  private usable() { return this.c.isReady && this.now() >= this.openUntil; }
  private ok() { this.fails = 0; }
  private bad() { if (++this.fails >= this.threshold) { this.openUntil = this.now() + this.breakerMs; this.fails = 0; } }
  private async guard<T>(p: Promise<T>): Promise<T> {
    let t: NodeJS.Timeout | undefined;
    try { return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("redis command timeout")), this.timeoutMs); })]); }
    finally { if (t) clearTimeout(t); }
  }

  async get(key: string) {
    if (!this.usable()) return null;
    try { const v = await this.guard(this.c.get(key)); this.ok(); return v; } catch { this.bad(); return null; }
  }
  async set(key: string, value: string, ttlSeconds: number) {
    if (!this.usable()) return false;
    try { await this.guard(this.c.set(key, value, { EX: Math.max(1, Math.floor(ttlSeconds)) })); this.ok(); return true; } catch { this.bad(); return false; }
  }
  async clear(prefix: string) {
    if (!this.c.isReady) return 0;
    let removed = 0;
    try {
      const batch: string[] = [];
      const flush = async () => { if (batch.length) { removed += await this.c.unlink(batch.splice(0)); } };
      for await (const k of this.c.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
        for (const key of Array.isArray(k) ? k : [k]) { batch.push(key); if (batch.length >= 200) await flush(); }
      }
      await flush();
    } catch { /* partial clear is reported by the count */ }
    return removed;
  }
  async size() { if (!this.usable()) return null; try { return await this.guard(this.c.dbSize()); } catch { return null; } }
  isReady() { return this.usable(); }
  async close() { try { await Promise.race([this.c.quit(), new Promise((r) => setTimeout(r, 500))]); } catch { this.c.destroy?.(); } }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
