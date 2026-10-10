import type { LlmClient, LlmMessage, LlmResponse, ToolSchema } from "../core/types.js";
import { recordMetric } from "../telemetry/otel.js";
import { CacheBackend, sha256 } from "./backends.js";
import { currentTenantId } from "../saas/context.js";
import { isSaasMode } from "../saas/roles.js";

export const KEY_PREFIX = "xcoder:llm:v1:";

export interface CacheStats {
  enabled: boolean; backend: "redis" | "memory" | "off"; ready: boolean; approxEntries: number | null;
  hits: number; misses: number; bypassed: number; stored: number; errors: number; ttlSeconds: number;
  /** Prompt+completion tokens that hits did not have to spend (as recorded when the entry was stored). */
  tokensSaved: number;
}

type Opts = { model?: string; temperature?: number; tools?: ToolSchema[]; responseFormat?: "json_object" };

export interface LlmCacheOptions {
  backend: CacheBackend;
  /** Everything about the configured model that changes the answer (provider, model, base url, max_tokens, thinking...). */
  fingerprint: () => Record<string, unknown>;
  /** Temperature the underlying client will use when the caller doesn't pass one. */
  defaultTemperature: number;
  /** Thinking/reasoning mode ignores temperature and is not reproducible, so it is never cached. */
  thinking: boolean;
  ttlSeconds: number;
  /** Only cache requests at or below this temperature (0 = fully deterministic only). */
  maxTemperature?: number;
  maxEntryBytes?: number;
  /** Extra isolation boundary mixed into every key (e.g. deployment name). */
  scope?: string;
  /** Counter sink. Share one object across clients (clients are created per request) to get process-wide totals. */
  counters?: Counters;
}

export interface Counters { hits: number; misses: number; bypassed: number; stored: number; errors: number; tokensSaved: number }
export const newCounters = (): Counters => ({ hits: 0, misses: 0, bypassed: 0, stored: 0, errors: 0, tokensSaved: 0 });

/** JSON with sorted keys and no `undefined`, so equal requests always hash equally. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, val]) => val !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, val]) => [k, norm(val)]));
    return x;
  };
  return JSON.stringify(norm(v));
}

/**
 * Exact-match response cache in front of any LlmClient. Used by chat and by tasks (the SDLC engine and its sub-agents
 * all go through the same client factory). A hit needs the byte-identical request: same messages, tools, model and
 * settings. Nothing semantic or fuzzy, so a hit can only ever return what the model already said to that exact input.
 *
 *  - never caches thinking mode, non-deterministic temperatures, truncated/filtered/empty answers
 *  - hits report zero token usage, so budgets and cost tracking reflect that nothing was spent
 *  - backend failures are swallowed (fail-open); the inner client always has the last word
 */
export class CachingLlmClient implements LlmClient {
  private s: Counters;
  constructor(private inner: LlmClient, private o: LlmCacheOptions) { this.s = o.counters ?? newCounters(); }

  key(messages: LlmMessage[], opts?: Opts): string {
    const fp = this.o.fingerprint();
    const model = opts?.model ?? fp.model;
    const temperature = opts?.temperature ?? this.o.defaultTemperature;
    return KEY_PREFIX + sha256(canonicalJson({ scope: this.o.scope ?? "", tenant: currentTenantId() ?? "", fp, model, temperature, tools: opts?.tools, rf: opts?.responseFormat, messages }));
  }

  private cacheable(messages: LlmMessage[], opts?: Opts): boolean {
    if (this.o.thinking || messages.length === 0) return false;
    // Multi-tenant: a request with no tenant scope (forked worker, background job) must neither read nor write the shared cache.
    if (isSaasMode() && !currentTenantId()) return false;
    return (opts?.temperature ?? this.o.defaultTemperature) <= (this.o.maxTemperature ?? 0);
  }
  private static storable(r: LlmResponse): boolean {
    if (r.finishReason === "length" || r.finishReason === "content_filter") return false;
    return Boolean((r.content ?? "").trim()) || (r.toolCalls?.length ?? 0) > 0;
  }
  private count(result: "hit" | "miss" | "bypass" | "error") {
    recordMetric((m) => m.cacheRequests.add(1, { result, backend: this.o.backend.kind }));
  }

  async complete(messages: LlmMessage[], opts?: Opts): Promise<LlmResponse> {
    if (!this.cacheable(messages, opts)) { this.s.bypassed++; this.count("bypass"); return this.inner.complete(messages, opts); }
    let key: string;
    try { key = this.key(messages, opts); } catch { this.s.errors++; this.count("error"); return this.inner.complete(messages, opts); }

    try {
      const raw = await this.o.backend.get(key);
      if (raw) {
        const hit = JSON.parse(raw) as { r: LlmResponse };
        if (hit?.r && typeof hit.r === "object" && typeof hit.r.content === "string" && Array.isArray(hit.r.toolCalls)) {
          this.s.hits++; this.s.tokensSaved += hit.r.usage?.totalTokens ?? 0; this.count("hit");
          return { ...hit.r, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: hit.r.usage?.promptTokens }, cacheHit: true };
        }
      }
    } catch { this.s.errors++; this.count("error"); }      // corrupt entry or backend error: treat as a miss

    this.s.misses++; this.count("miss");
    const res = await this.inner.complete(messages, opts);
    if (CachingLlmClient.storable(res)) {
      try {
        const val = JSON.stringify({ r: res });
        if (val.length <= (this.o.maxEntryBytes ?? 512 * 1024) && (await this.o.backend.set(key, val, this.o.ttlSeconds))) this.s.stored++;
      } catch { this.s.errors++; }
    }
    return res;
  }

  stats(): CacheStats { return { ...this.s, enabled: true, backend: this.o.backend.kind, ready: this.o.backend.isReady(), approxEntries: null, ttlSeconds: this.o.ttlSeconds }; }
}
