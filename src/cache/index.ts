import { readFileSync } from "node:fs";
import type { LlmClient } from "../core/types.js";
import type { LlmConfig } from "../config/loadConfig.js";
import { resolveModelForSkill } from "../config/loadConfig.js";
import { CacheBackend, MemoryBackend, RedisBackend, redactUrl } from "./backends.js";
import { CachingLlmClient, CacheStats, KEY_PREFIX, newCounters } from "./llmCache.js";

export type { CacheStats } from "./llmCache.js";
export { CachingLlmClient } from "./llmCache.js";

/**
 * Configuration (all optional):
 *   XCODER_CACHE                 auto (default: Redis when XCODER_REDIS_URL is set, otherwise off) | redis | memory | off
 *   XCODER_REDIS_URL             e.g. redis://redis:6379
 *   XCODER_REDIS_PASSWORD        or XCODER_REDIS_PASSWORD_FILE (Docker secret)
 *   XCODER_CACHE_TTL_SECONDS     default 86400
 *   XCODER_CACHE_MAX_TEMPERATURE default 0 (only fully deterministic requests are cached)
 *   XCODER_CACHE_SCOPE           optional string mixed into every key
 */
export interface CacheEnvConfig { mode: "redis" | "memory" | "off"; url?: string; password?: string; ttlSeconds: number; maxTemperature: number; scope?: string }

export function cacheConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CacheEnvConfig {
  const raw = (env.XCODER_CACHE ?? "auto").trim().toLowerCase();
  const url = env.XCODER_REDIS_URL?.trim() || undefined;
  let password = env.XCODER_REDIS_PASSWORD || undefined;
  if (!password && env.XCODER_REDIS_PASSWORD_FILE) { try { password = readFileSync(env.XCODER_REDIS_PASSWORD_FILE, "utf8").trim() || undefined; } catch { /* reported as auth failure by redis */ } }
  let mode: CacheEnvConfig["mode"];
  if (raw === "off" || raw === "false" || raw === "0") mode = "off";
  else if (raw === "memory") mode = "memory";
  else if (raw === "redis") mode = url ? "redis" : "off";          // asked for redis without a URL: refuse silently rather than guess
  else mode = url ? "redis" : "off";                               // auto
  const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d; };
  const ttl = num(env.XCODER_CACHE_TTL_SECONDS, 86_400);
  return { mode, url, password, ttlSeconds: ttl > 0 ? ttl : 86_400, maxTemperature: num(env.XCODER_CACHE_MAX_TEMPERATURE, 0), scope: env.XCODER_CACHE_SCOPE || undefined };
}

let shared: { backend: CacheBackend; cfg: CacheEnvConfig } | null | undefined;
/** Process-wide counters: clients are created per request, so they all report into this one object. */
let totals = newCounters();

/** Process-wide backend, created lazily on first use. null when caching is off. */
export function getCacheBackend(env: NodeJS.ProcessEnv = process.env): { backend: CacheBackend; cfg: CacheEnvConfig } | null {
  if (shared !== undefined) return shared;
  const cfg = cacheConfigFromEnv(env);
  if (cfg.mode === "off") { shared = null; return shared; }
  const backend = cfg.mode === "memory" ? new MemoryBackend() : new RedisBackend({ url: cfg.url!, password: cfg.password });
  console.log(`[cache] LLM response cache on (${cfg.mode}${cfg.mode === "redis" ? " " + redactUrl(cfg.url!) : ""}, ttl ${cfg.ttlSeconds}s)`);
  shared = { backend, cfg };
  return shared;
}

/** Wrap a real LLM client with the response cache when enabled; otherwise return it untouched. */
export function withLlmCache(client: LlmClient, config: LlmConfig, skillName?: string): LlmClient {
  const c = getCacheBackend();
  if (!c) return client;
  const resolved = resolveModelForSkill(config, skillName);
  return new CachingLlmClient(client, {
    backend: c.backend,
    defaultTemperature: resolved.temperature,
    thinking: Boolean(resolved.thinking),
    ttlSeconds: c.cfg.ttlSeconds,
    maxTemperature: c.cfg.maxTemperature,
    scope: c.cfg.scope,
    counters: totals,
    fingerprint: () => ({
      provider: config.provider, model: resolved.model, baseUrl: config.base_url ?? null, maxTokens: config.max_tokens,
      fallback: config.fallback ? { provider: config.fallback.provider, model: (config.fallback as { model?: string }).model ?? null } : null,
    }),
  });
}

/** Cache counters for this process, plus backend info. */
export async function getCacheStats(): Promise<CacheStats> {
  const c = getCacheBackend();
  if (!c) return { enabled: false, backend: "off", ready: false, approxEntries: null, ttlSeconds: 0, ...totals };
  return { enabled: true, backend: c.backend.kind, ready: c.backend.isReady(), approxEntries: await c.backend.size(), ttlSeconds: c.cfg.ttlSeconds, ...totals };
}

/** Remove every cached LLM response (admin action). Returns how many entries were removed. */
export async function clearCache(): Promise<number> {
  const c = getCacheBackend();
  return c ? c.backend.clear(KEY_PREFIX) : 0;
}

export async function closeCache(): Promise<void> {
  if (shared) { const s = shared; shared = undefined; await s.backend.close(); }
}
/** Test helper: forget the process-wide backend so the next call re-reads the environment. */
export function resetCacheForTests() { shared = undefined; totals = newCounters(); }
