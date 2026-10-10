import type { Request, Response, Router } from "express";
import { principalOf } from "../saas/gate.js";
import { requirePlatformAdmin, requirePlatformStaff, requireTenantAdmin, requireTenantMember } from "../saas/guards.js";
import { DEFAULT_TENANT_ID, isSaasMode } from "../saas/roles.js";
import { getTenant, setTenantAgi } from "../saas/tenantStore.js";
import { KNOWN_PROVIDER_DEFAULTS } from "../api/llmConfigStore.js";
import { getStoredApiKey } from "../api/llmKeyStore.js";
import { loadLlmConfig } from "../config/loadConfig.js";
import { appendAuditLog } from "../api/auditLog.js";
import { appendTenantAudit } from "../saas/audit.js";
import { LlmNotConfiguredError, PURPOSES, SLOTS, getPolicy, listConnections, removeConnection, resolveLlm, saveConnection, setPolicy, testConnection, agiPayloadFor, resolvePlatform, type Purpose, type Slot } from "./connections.js";
import { seal } from "./secretBox.js";

const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });
const fail = (res: Response, status: number, error: string) => res.status(status).json({ success: false, error });

export interface LlmRouteDeps { checkTaskRateLimit(userId: string): { limited: boolean; retryAfterMs?: number } }

function parseBody(body: unknown): { conn: unknown; apiKey: string | null | undefined } {
  const b = (body ?? {}) as Record<string, unknown>;
  const { apiKey, ...rest } = b;
  return { conn: rest, apiKey: apiKey === null ? null : typeof apiKey === "string" ? (apiKey === "" ? undefined : apiKey) : undefined };
}
const slotOf = (req: Request): Slot | null => (SLOTS.includes(String(req.params.slot) as Slot) ? (String(req.params.slot) as Slot) : null);
const purposeOfSlot = (s: Slot): Purpose => (s === "default" ? "task" : s);

export function registerLlmRoutes(router: Router, deps: LlmRouteDeps): void {
  const me = (req: Request) => principalOf(req);
  const member = requireTenantMember(me), tadmin = requireTenantAdmin(me), staff = requirePlatformStaff(me), owner = requirePlatformAdmin(me);
  const needSaas = (_q: Request, res: Response, next: () => void) => (isSaasMode() ? next() : fail(res, 404, "Multi-tenant mode is off"));
  const tenantAudit = (req: Request, action: string, summary: string) => { const p = me(req)!; appendTenantAudit(p.tenantId, { actorId: p.userId, actorUsername: p.username, action, summary }); };
  const platformAudit = (req: Request, action: string, summary: string, tenantId?: string) => {
    const p = me(req)!; appendAuditLog(process.cwd(), { actorId: p.userId, actorUsername: p.username, action, summary, details: { tenantId } });
    if (tenantId) appendTenantAudit(tenantId, { actorId: p.userId, actorUsername: `${p.username} (platform)`, action, summary });
  };

  /** What each purpose resolves to for a tenant, without secrets. */
  async function effective(tenantId: string, dedicatedAgi: boolean) {
    const out: Record<string, unknown> = {};
    for (const purpose of PURPOSES) {
      if (purpose === "agi" && !dedicatedAgi && isSaasMode()) { out.agi = { available: false }; continue; }
      try {
        const r = await resolveLlm(purpose, tenantId);
        out[purpose] = { available: true, source: r.source, ownKey: r.byo, provider: r.byo ? r.config.provider : undefined, model: r.config.model, ...(purpose === "agi" ? { explicit: Boolean(await agiPayloadFor(tenantId)) } : {}) };
      } catch (e) { out[purpose] = { available: false, error: e instanceof LlmNotConfiguredError ? e.message : "unavailable" }; }
    }
    return out;
  }

  // ── tenant admin / legacy admin: own connections ─────────────────────────────────────
  router.get("/llm/connections", member, async (req, res) => {
    const tid = me(req)!.tenantId || DEFAULT_TENANT_ID;
    const t = getTenant(tid); const p = getPolicy();
    ok(res, {
      saasMode: isSaasMode(),
      policy: isSaasMode() ? { tenantMayConfigure: p.tenantMayConfigure, platformFallback: p.platformFallback, allowedProviders: p.allowedProviders } : { tenantMayConfigure: true, platformFallback: true, allowedProviders: [] },
      connections: listConnections(tid),
      effective: await effective(tid, !!t?.agi || !isSaasMode()),
      providers: KNOWN_PROVIDER_DEFAULTS,
    });
  });
  router.put("/llm/connections/:slot", tadmin, async (req, res) => {
    const slot = slotOf(req); if (!slot) return fail(res, 404, "Unknown slot");
    const tid = me(req)!.tenantId || DEFAULT_TENANT_ID;
    if (slot === "agi" && isSaasMode() && !getTenant(tid)?.agi) return fail(res, 409, "Your organization has no dedicated AGI instance. Ask the SaaS owner to set one up.");
    const { conn, apiKey } = parseBody(req.body);
    const err = await saveConnection(tid, slot, conn, apiKey);
    if (err) return fail(res, 400, err);
    const v = (conn as { mode?: string; provider?: string; model?: string });
    (isSaasMode() ? tenantAudit : () => {})(req, "llm.connection", `set '${slot}' LLM connection (${v.mode}${v.provider ? ", " + v.provider : ""}${v.model ? ", " + v.model : ""})${apiKey ? ", key updated" : ""}`);
    ok(res, listConnections(tid));
  });
  router.delete("/llm/connections/:slot", tadmin, (req, res) => {
    const slot = slotOf(req); if (!slot) return fail(res, 404, "Unknown slot");
    const tid = me(req)!.tenantId || DEFAULT_TENANT_ID;
    if (!removeConnection(tid, slot)) return fail(res, 404, "Nothing configured for that slot");
    if (isSaasMode()) tenantAudit(req, "llm.connection", `removed '${slot}' LLM connection`);
    ok(res, listConnections(tid));
  });
  router.post("/llm/connections/:slot/test", tadmin, async (req, res) => {
    const slot = slotOf(req); if (!slot) return fail(res, 404, "Unknown slot");
    const p = me(req)!; const rl = deps.checkTaskRateLimit(p.userId);
    if (rl.limited) return fail(res, 429, `Too many tests. Try again in ${Math.ceil((rl.retryAfterMs ?? 0) / 1000)}s.`);
    try { ok(res, await testConnection(await resolveLlm(purposeOfSlot(slot), p.tenantId))); }
    catch (e) { if (e instanceof LlmNotConfiguredError) return ok(res, { ok: false, ms: 0, model: "", provider: "", error: e.message }); throw e; }
  });

  // ── platform: policy, platform per-purpose overrides, per-tenant visibility, dedicated AGI ───
  router.get("/saas/llm", needSaas, staff, (_req, res) => {
    let base: { provider: string; model: string; base_url?: string; hasKey: boolean } | null = null;
    try { const c = loadLlmConfig(); base = { provider: c.provider, model: c.model, base_url: c.base_url, hasKey: Boolean(getStoredApiKey() || (c.api_key_env && process.env[c.api_key_env])) }; } catch { /* none */ }
    ok(res, { policy: getPolicy(), default: base, overrides: listConnections(null), providers: KNOWN_PROVIDER_DEFAULTS });
  });
  router.put("/saas/llm/policy", needSaas, owner, (req, res) => {
    const r = setPolicy((req.body ?? {}) as Record<string, never>); if (typeof r === "string") return fail(res, 400, r);
    platformAudit(req, "saas.llm.policy", `updated tenant LLM policy: ${JSON.stringify(r)}`); ok(res, r);
  });
  router.put("/saas/llm/platform/:slot", needSaas, owner, async (req, res) => {
    const slot = slotOf(req); if (!slot) return fail(res, 404, "Unknown slot");
    const { conn, apiKey } = parseBody(req.body); const err = await saveConnection(null, slot, conn, apiKey); if (err) return fail(res, 400, err);
    platformAudit(req, "saas.llm.platform", `set platform '${slot}' LLM override${apiKey ? ", key updated" : ""}`); ok(res, listConnections(null));
  });
  router.delete("/saas/llm/platform/:slot", needSaas, owner, (req, res) => {
    const slot = slotOf(req); if (!slot) return fail(res, 404, "Unknown slot");
    if (!removeConnection(null, slot)) return fail(res, 404, "No override for that slot");
    platformAudit(req, "saas.llm.platform", `removed platform '${slot}' LLM override`); ok(res, listConnections(null));
  });
  router.post("/saas/llm/platform/:slot/test", needSaas, owner, async (req, res) => {
    const slot = slotOf(req); if (!slot) return fail(res, 404, "Unknown slot");
    const rl = deps.checkTaskRateLimit(me(req)!.userId); if (rl.limited) return fail(res, 429, "Too many tests");
    try { ok(res, await testConnection(resolvePlatform(purposeOfSlot(slot)))); } catch (e) { fail(res, 400, e instanceof Error ? e.message : "failed"); }
  });
  router.get("/saas/tenants/:id/llm", needSaas, staff, (req, res) => {
    const t = getTenant(String(req.params.id)); if (!t) return fail(res, 404, "Tenant not found");
    ok(res, { connections: listConnections(t.id), agi: t.agi ? { url: t.agi.url, hasToken: !!t.agi.token } : null });
  });
  router.delete("/saas/tenants/:id/llm/:slot", needSaas, owner, (req, res) => {
    const t = getTenant(String(req.params.id)); const slot = slotOf(req); if (!t || !slot) return fail(res, 404, "Not found");
    if (!removeConnection(t.id, slot)) return fail(res, 404, "Nothing configured for that slot");
    platformAudit(req, "saas.llm.tenant_reset", `removed tenant '${slot}' LLM connection`, t.id); ok(res, listConnections(t.id));
  });
  // Dedicated AGI instance for a tenant (the only tenant-safe way to give a tenant its own agent).
  router.put("/saas/tenants/:id/agi", needSaas, owner, (req, res) => {
    const b = (req.body ?? {}) as { url?: unknown; token?: unknown };
    let origin: string; try { const u = new URL(String(b.url)); if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("x"); if (u.username || u.password) throw new Error("x"); origin = u.origin; } catch { return fail(res, 400, "url must be an http(s) URL without credentials"); }
    if (b.token !== undefined && (typeof b.token !== "string" || b.token.length < 16 || b.token.length > 300)) return fail(res, 400, "token must be 16-300 characters");
    const prev = getTenant(String(req.params.id));
    const r = setTenantAgi(String(req.params.id), { url: origin, token: typeof b.token === "string" ? seal(b.token) : prev?.agi?.token });
    if (typeof r === "string") return fail(res, 404, r);
    platformAudit(req, "saas.agi.dedicated", `set dedicated AGI instance ${origin}`, r.id); ok(res, { url: origin, hasToken: !!r.agi?.token });
  });
  router.delete("/saas/tenants/:id/agi", needSaas, owner, (req, res) => {
    const r = setTenantAgi(String(req.params.id), null); if (typeof r === "string") return fail(res, 404, r);
    platformAudit(req, "saas.agi.dedicated", "removed dedicated AGI instance", r.id); ok(res, { removed: true });
  });
}
