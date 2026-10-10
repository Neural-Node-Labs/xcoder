import path from "node:path";
import { DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS, loadLlmConfig, providerRequiresNoAuth, type LlmConfig } from "../config/loadConfig.js";
import { getStoredApiKey } from "../api/llmKeyStore.js";
import { DEFAULT_TENANT_ID, isSaasMode } from "../saas/roles.js";
import { readJson, saasDataDir, tenantDir, writeJsonAtomic } from "../saas/storage.js";
import { open, seal, type Sealed } from "./secretBox.js";
import { assertSafeProviderUrl } from "./netGuard.js";

/**
 * ONE place that decides which LLM connection a request uses.
 *
 *   platform base  = agent/config/llm.yaml + the platform key (Settings page) [+ optional platform per-purpose override]
 *   tenant config  = <saasDataDir>/tenants/<id>/llm.json  (legacy single-tenant mode uses the tenant "default")
 *
 * Purposes: "chat" (Assistant chat), "task" (SDLC / plan / execute runs), "agi" (the AGI agent). A purpose falls back to
 * the scope's "default" entry, then (policy permitting) to the platform. Secrets are AES-GCM sealed at rest, handed to the
 * client as an explicit `api_key` (never via process.env, which is shared between tenants), and never returned by any API.
 */
export const PURPOSES = ["chat", "task", "agi"] as const;
export type Purpose = (typeof PURPOSES)[number];
export type Slot = Purpose | "default";
export const SLOTS: Slot[] = ["default", ...PURPOSES];

export interface ConnectionInput {
  /** "platform" = use the platform's connection (optionally with my own model/temperature); "custom" = my own provider + key. */
  mode: "platform" | "custom";
  provider?: string; base_url?: string; endpoint?: string; model?: string;
  max_tokens?: number; temperature?: number; thinking?: boolean;
  /** AGI only: per-tier models (the agent routes easy/medium/hard steps to different models). */
  tier_models?: { easy?: string; medium?: string; hard?: string };
}
interface Stored extends ConnectionInput { key?: Sealed; updatedAt: string }
interface Scope { slots: Partial<Record<Slot, Stored>> }
export interface Policy {
  /** Tenants may set their own connections. */
  tenantMayConfigure: boolean;
  /** A tenant with no usable config of its own falls back to the platform connection (and its quota). */
  platformFallback: boolean;
  /** Allow tenant base URLs on private networks (self-hosted gateways). Off by default: SSRF. */
  allowPrivateUrls: boolean;
  /** If non-empty, tenants may only choose these providers. */
  allowedProviders: string[];
}
const DEFAULT_POLICY: Policy = { tenantMayConfigure: true, platformFallback: true, allowPrivateUrls: false, allowedProviders: [] };

const platformFile = () => path.join(saasDataDir(), "llm-platform.json");
const tenantFile = (id: string) => path.join(tenantDir(id), "llm.json");
const cache = new Map<string, Scope>();
let policyCache: Policy | null = null;
export function resetLlmCacheForTests() { cache.clear(); policyCache = null; }

const scopeKey = (tenantId: string | null) => tenantId ?? "@platform";
function loadScope(tenantId: string | null): Scope {
  const k = scopeKey(tenantId);
  let s = cache.get(k);
  if (!s) { s = { slots: {}, ...readJson<Partial<Scope>>(tenantId ? tenantFile(tenantId) : platformFile(), {}) } as Scope; s.slots ??= {}; cache.set(k, s); }
  return s;
}
const saveScope = (tenantId: string | null) => writeJsonAtomic(tenantId ? tenantFile(tenantId) : platformFile(), loadScope(tenantId));

export function getPolicy(): Policy {
  return (policyCache ??= { ...DEFAULT_POLICY, ...(readJson<{ policy?: Partial<Policy> }>(path.join(saasDataDir(), "llm-policy.json"), {}).policy ?? {}) });
}
export function setPolicy(patch: Partial<Policy>): Policy | string {
  const next: Policy = { ...getPolicy() };
  if (patch.tenantMayConfigure !== undefined) { if (typeof patch.tenantMayConfigure !== "boolean") return "tenantMayConfigure must be boolean"; next.tenantMayConfigure = patch.tenantMayConfigure; }
  if (patch.platformFallback !== undefined) { if (typeof patch.platformFallback !== "boolean") return "platformFallback must be boolean"; next.platformFallback = patch.platformFallback; }
  if (patch.allowPrivateUrls !== undefined) { if (typeof patch.allowPrivateUrls !== "boolean") return "allowPrivateUrls must be boolean"; next.allowPrivateUrls = patch.allowPrivateUrls; }
  if (patch.allowedProviders !== undefined) {
    if (!Array.isArray(patch.allowedProviders) || patch.allowedProviders.some((p) => typeof p !== "string" || !/^[a-z0-9-]{2,30}$/.test(p))) return "allowedProviders must be an array of provider names";
    next.allowedProviders = patch.allowedProviders;
  }
  policyCache = next; writeJsonAtomic(path.join(saasDataDir(), "llm-policy.json"), { policy: next });
  return next;
}

// ─── validation + storage ─────────────────────────────────────────────────────────────
const PROVIDER_RE = /^[a-z0-9-]{2,30}$/;
const MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,120}$/;

/** Validates and stores one slot. `apiKey`: string = replace, null = remove, undefined = keep. Returns an error string or null. */
export async function saveConnection(tenantId: string | null, slot: Slot, input: unknown, apiKey: string | null | undefined): Promise<string | null> {
  if (!SLOTS.includes(slot)) return "Unknown connection slot";
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "Body must be an object";
  const b = input as Record<string, unknown>;
  const mode = b.mode === "custom" ? "custom" : b.mode === "platform" ? "platform" : null;
  if (!mode) return "mode must be 'platform' or 'custom'";
  const policy = getPolicy();
  if (tenantId !== null && isSaasMode() && !policy.tenantMayConfigure) return "Your organization is not allowed to change LLM connections";
  const out: Stored = { mode, updatedAt: new Date().toISOString() };
  const str = (k: string, re: RegExp, label: string): string | null | undefined => { const v = b[k]; if (v === undefined || v === "") return undefined; if (typeof v !== "string" || !re.test(v)) { return null; } return v; };
  const num = (k: string, lo: number, hi: number): number | null | undefined => { const v = b[k]; if (v === undefined) return undefined; if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return null; return v; };
  const model = str("model", MODEL_RE, "model"); if (model === null) return "model contains invalid characters";
  const mt = num("max_tokens", 256, 200_000); if (mt === null) return "max_tokens must be 256-200000";
  const temp = num("temperature", 0, 2); if (temp === null) return "temperature must be 0-2";
  if (b.thinking !== undefined && typeof b.thinking !== "boolean") return "thinking must be boolean";
  if (b.tier_models !== undefined) {
    if (typeof b.tier_models !== "object" || b.tier_models === null || Array.isArray(b.tier_models)) return "tier_models must be an object";
    const tm: Record<string, string> = {};
    for (const t of ["easy", "medium", "hard"]) { const v = (b.tier_models as Record<string, unknown>)[t]; if (v === undefined || v === "") continue; if (typeof v !== "string" || !MODEL_RE.test(v)) return `tier_models.${t} contains invalid characters`; tm[t] = v; }
    if (Object.keys(tm).length) out.tier_models = tm;
  }
  if (model) out.model = model; if (mt !== undefined) out.max_tokens = mt; if (temp !== undefined) out.temperature = temp; if (b.thinking !== undefined) out.thinking = b.thinking as boolean;

  if (mode === "custom") {
    const provider = str("provider", PROVIDER_RE, "provider"); if (!provider) return "provider is required (lowercase letters, digits, dashes)";
    if (tenantId !== null && isSaasMode() && policy.allowedProviders.length && !policy.allowedProviders.includes(provider)) return `provider '${provider}' is not allowed. Allowed: ${policy.allowedProviders.join(", ")}`;
    if (!out.model) return "model is required";
    out.provider = provider;
    let base = typeof b.base_url === "string" && b.base_url.trim() ? b.base_url.trim() : undefined;
    if (!base && provider !== "anthropic") base = DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS[provider];
    if (provider === "anthropic") base = undefined; // fixed Messages endpoint
    if (!base && provider !== "anthropic") return "base_url is required for this provider";
    if (base) {
      try { out.base_url = await assertSafeProviderUrl(base, { allowPrivate: tenantId === null || !isSaasMode() || policy.allowPrivateUrls, allowHttp: tenantId === null || !isSaasMode() || policy.allowPrivateUrls }); } catch (e) { return (e as Error).message; }
    }
    if (typeof b.endpoint === "string" && b.endpoint) { if (!/^\/[A-Za-z0-9/_.-]{1,100}$/.test(b.endpoint)) return "endpoint must be a path like /chat/completions"; out.endpoint = b.endpoint; }
  }
  const prev = loadScope(tenantId).slots[slot];
  if (apiKey === null) { /* removed */ }
  else if (typeof apiKey === "string") { if (apiKey.length < 8 || apiKey.length > 500 || /\s/.test(apiKey)) return "apiKey looks invalid"; out.key = seal(apiKey); }
  else if (prev?.key && mode === "custom") out.key = prev.key;
  loadScope(tenantId).slots[slot] = out; saveScope(tenantId);
  return null;
}
export function removeConnection(tenantId: string | null, slot: Slot): boolean {
  const s = loadScope(tenantId); if (!s.slots[slot]) return false; delete s.slots[slot]; saveScope(tenantId); return true;
}

export interface ConnectionView { slot: Slot; tier_models?: Stored["tier_models"]; mode: "platform" | "custom"; provider?: string; base_url?: string; endpoint?: string; model?: string; max_tokens?: number; temperature?: number; thinking?: boolean; hasKey: boolean; updatedAt: string }
/** Safe to return to a browser: never includes the key. */
export function listConnections(tenantId: string | null): ConnectionView[] {
  return Object.entries(loadScope(tenantId).slots).map(([slot, s]) => ({ slot: slot as Slot, mode: s!.mode, provider: s!.provider, base_url: s!.base_url, endpoint: s!.endpoint, model: s!.model, max_tokens: s!.max_tokens, temperature: s!.temperature, thinking: s!.thinking, tier_models: s!.tier_models, hasKey: !!s!.key, updatedAt: s!.updatedAt }));
}

// ─── resolution ──────────────────────────────────────────────────────────────────────
export interface Resolved {
  config: LlmConfig;
  source: "tenant" | "platform";
  /** The tenant is paying for the tokens itself (own key): the platform allowance does not apply. */
  byo: boolean;
  slot: Slot | null;
  tiers?: Stored["tier_models"];
}
export class LlmNotConfiguredError extends Error {}

function platformBase(purpose: Purpose): LlmConfig {
  const override = loadScope(null).slots[purpose] ?? loadScope(null).slots.default;
  const base = loadLlmConfig();
  const cfg: LlmConfig = { ...base };
  // explicit key, never process.env mutation
  const stored = getStoredApiKey();
  const envKey = base.api_key_env ? process.env[base.api_key_env] : undefined;
  if (stored || envKey) cfg.api_key = stored ?? envKey;
  if (override) applyStored(cfg, override, true);
  return cfg;
}
function applyStored(cfg: LlmConfig, s: Stored, platformScope: boolean): void {
  if (s.mode === "custom") {
    cfg.provider = s.provider!; cfg.base_url = s.base_url; cfg.endpoint = s.endpoint; delete cfg.api_key_env; delete cfg.fallback; delete cfg.overrides;
    cfg.api_key = open(s.key);
    if (!s.endpoint) delete cfg.endpoint;
  } else if (!platformScope) { /* platform mode: keep platform provider + key */ }
  else if (s.key) cfg.api_key = open(s.key);
  if (s.model) cfg.model = s.model;
  if (s.max_tokens) cfg.max_tokens = s.max_tokens;
  if (s.temperature !== undefined) cfg.temperature = s.temperature;
  if (s.thinking !== undefined) cfg.thinking = s.thinking;
}

/**
 * Pick the connection for (tenant, purpose). Throws LlmNotConfiguredError with a user-safe message when none is usable.
 * Async because a tenant's custom URL is re-validated (DNS) every time a client is built.
 */
export async function resolveLlm(purpose: Purpose, tenantId: string | null | undefined): Promise<Resolved> {
  const tid = tenantId || DEFAULT_TENANT_ID;
  const slots = loadScope(tid).slots;
  const own = slots[purpose] ?? slots.default;
  const policy = getPolicy();
  const saas = isSaasMode();
  if (own) {
    if (own.mode === "custom") {
      if (saas && !policy.allowPrivateUrls && own.base_url) {
        try { await assertSafeProviderUrl(own.base_url, {}); } catch (e) { throw new LlmNotConfiguredError(`Your LLM connection was rejected: ${(e as Error).message}`); }
      }
      const cfg: LlmConfig = { provider: own.provider!, base_url: own.base_url, endpoint: own.endpoint, model: own.model!, max_tokens: own.max_tokens ?? 16384, temperature: own.temperature ?? 0, thinking: own.thinking ?? false };
      if (!cfg.endpoint) delete cfg.endpoint; if (!cfg.base_url) delete cfg.base_url;
      cfg.api_key = open(own.key);
      if (!cfg.api_key && !providerRequiresNoAuth(cfg.provider)) throw new LlmNotConfiguredError("Your LLM connection has no API key (or it could not be decrypted). Enter it again in Settings.");
      return { config: cfg, source: "tenant", byo: true, slot: purpose in slots ? purpose : "default", tiers: own.tier_models };
    }
    // mode "platform": platform connection with this tenant's model/limits
    const cfg = platformBase(purpose); applyStored(cfg, own, false);
    return { config: cfg, source: "platform", byo: false, slot: purpose in slots ? purpose : "default", tiers: own.tier_models };
  }
  if (saas && !policy.platformFallback) throw new LlmNotConfiguredError("No LLM connection is configured for your organization. Ask your admin to add one in Settings > LLM connections.");
  return { config: platformBase(purpose), source: "platform", byo: false, slot: null };
}

/** The purpose a /chat request belongs to. */
export const purposeForEngine = (engine: string | undefined): Purpose => (engine === "assistant" ? "chat" : "task");

/** True when this tenant has its own custom connection for chat/task (used to skip the platform-allowance pre-check). */
export function tenantUsesOwnKey(tenantId: string): boolean {
  const sl = loadScope(tenantId).slots;
  return [sl.task ?? sl.default, sl.chat ?? sl.default].some((x) => x?.mode === "custom" && !!x.key);
}

// ─── connection test ─────────────────────────────────────────────────────────────────
export async function testConnection(r: Resolved): Promise<{ ok: boolean; ms: number; model: string; provider: string; reply?: string; error?: string }> {
  const { DeepSeekClient } = await import("./deepseekClient.js");
  const key = r.config.api_key;
  const clean = (m: string) => { let o = m; if (key) o = o.split(key).join("[redacted]"); return o.replace(/(sk-|key-|Bearer\s+)[A-Za-z0-9._-]{8,}/g, "$1[redacted]").slice(0, 300); };
  const t0 = Date.now();
  const cfg: LlmConfig = { ...r.config, max_tokens: Math.min(r.config.max_tokens, 64), thinking: false };
  try {
    const out = await Promise.race([
      new DeepSeekClient(cfg).complete([{ role: "user", content: "Reply with the single word OK." }], { temperature: 0 }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out after 25s")), 25_000).unref()),
    ]);
    return { ok: true, ms: Date.now() - t0, model: cfg.model, provider: cfg.provider, reply: (out.content ?? "").trim().slice(0, 40) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, model: cfg.model, provider: cfg.provider, error: clean(e instanceof Error ? e.message : String(e)) };
  }
}

// ─── AGI ─────────────────────────────────────────────────────────────────────────────
/** What the AGI service needs (see integrations/agi PUT /llm). */
export interface AgiLlmPayload { fp: string; mode: "anthropic" | "openai"; baseUrl?: string; endpoint?: string; apiKey?: string; models: { easy: string; medium: string; hard: string } }

/**
 * The connection to push to an AGI instance, or null when nobody has configured one explicitly (the instance then keeps
 * its own env defaults, so enabling this feature never silently re-points an existing agent).
 * tenantId null = the platform AGI (staff); otherwise that tenant's dedicated instance (legacy single-tenant: "default").
 */
export async function agiPayloadFor(tenantId: string | null): Promise<AgiLlmPayload | null> {
  let r: Resolved | null = null;
  if (tenantId === null) {
    const o = loadScope(null).slots.agi ?? loadScope(null).slots.default;
    if (!o) return null;
    const cfg = platformBase("agi");
    r = { config: cfg, source: "platform", byo: false, slot: "agi", tiers: o.tier_models };
  } else {
    const sl = loadScope(tenantId).slots;
    if (!(sl.agi ?? sl.default)) return null;
    r = await resolveLlm("agi", tenantId);
  }
  const c = r.config, model = c.model;
  const models = { easy: r.tiers?.easy ?? model, medium: r.tiers?.medium ?? model, hard: r.tiers?.hard ?? model };
  const anthropic = c.provider === "anthropic";
  const baseUrl = anthropic ? undefined : (c.base_url ?? DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS[c.provider]);
  if (!anthropic && !baseUrl) return null;
  const endpoint = anthropic ? undefined : (c.endpoint ?? "/chat/completions");
  const fp = (await import("node:crypto")).createHash("sha256").update(JSON.stringify([anthropic ? "anthropic" : "openai", baseUrl, endpoint, models, c.api_key ?? ""])).digest("hex").slice(0, 32);
  return { fp, mode: anthropic ? "anthropic" : "openai", baseUrl, endpoint, apiKey: c.api_key, models };
}

/** Platform-scope resolution for a purpose (owner "test" button). */
export function resolvePlatform(purpose: Purpose): Resolved {
  return { config: platformBase(purpose), source: "platform", byo: false, slot: null };
}
