import type { NextFunction, Request, Response } from "express";
import { runWithTenant } from "./context.js";
import { DEFAULT_TENANT_ID, isPlatformStaff, isSaasMode, isTenantMember, type Role } from "./roles.js";
import { quotaExceeded } from "./usage.js";
import { tenantUsesOwnKey } from "../llm/connections.js";
import { resolveTenant, type Principal } from "./guards.js";

export function principalOf(req: Request): Principal | undefined {
  const u = (req as { user?: { userId: string; username: string; role: Role; tenantId?: string } }).user;
  return u ? { userId: u.userId, username: u.username, role: u.role, tenantId: u.tenantId || DEFAULT_TENANT_ID } : undefined;
}

/** [method regex or "*", path regex, rule]. First match wins. */
type Rule = { method?: string; path: RegExp; kind: "tenant_content" | "platform_only" | "feature" | "disabled"; feature?: string; message?: string };

/**
 * SaaS route policy, applied to EVERY authenticated request in SaaS mode (default-deny on content for platform staff,
 * default-deny on platform surfaces for tenants). New routes inherit the tenant_content rule by living under a listed prefix.
 *   tenant_content  data that belongs to a tenant: platform staff (owner/ops) are refused
 *   platform_only   platform-wide state: tenants are refused
 *   feature         module that can be switched off
 */
export const ROUTE_POLICY: Rule[] = [
  // Postgres telemetry rows are keyed by task id only (no tenant column yet): off in SaaS mode.
  { path: /^\/task-history\/[^/]+\/logs/, kind: "disabled", message: "Task logs are not available in multi-tenant mode yet (storage is not tenant-scoped)" },
  { path: /^\/users(\/|$)/, kind: "platform_only", message: "Use /tenant/users (tenant admins) or /saas/staff (SaaS owner) in SaaS mode" },
  { path: /^\/telemetry(\/|$)/, kind: "platform_only", message: "Server logs are platform-only in SaaS mode" },
  { path: /^\/audit-log(\/|$)/, kind: "platform_only", message: "Use /tenant/audit-log for your tenant" },
  { path: /^\/settings\/llm-/, kind: "platform_only", message: "Platform LLM settings are owner-only. Use /llm/connections for your organization." },
  { method: "PUT|POST|DELETE", path: /^\/settings\//, kind: "platform_only" },
  { path: /^\/platform\/cache/, kind: "platform_only" },
  { path: /^\/platform\/integrations\/codegraph/, kind: "feature", feature: "codegraph" },
  { path: /^\/codegraph-api(\/|$)/, kind: "feature", feature: "codegraph" },
  { path: /^\/agi(\/|$)/, kind: "feature", feature: "agi" },
  { path: /^\/security-ops(\/|$)/, kind: "feature", feature: "security_ops" },
  { path: /^\/crm(\/|$)/, kind: "feature", feature: "crm" },
  { path: /^\/saas(\/|$)/, kind: "feature", feature: "saas_management" },
  { path: /^\/(chat|projects|plans|task-history|phase-reports|wbs|workspace|crm|tenant|llm)(\/|$)/, kind: "tenant_content" },
];

/** Paths whose handlers do their own staff/tenant checks (the rules above only gate the feature switch). */
const STAFF_PREFIXES = [/^\/saas(\/|$)/, /^\/platform\/integrations\/codegraph/, /^\/codegraph-api/];

export function tenantGate(req: Request, res: Response, next: NextFunction): void {
  const p = principalOf(req);
  if (!p) return next(); // authMiddleware already rejected anonymous callers
  const r = resolveTenant(p);
  if (r.error) { res.status(r.error.status).json({ success: false, error: r.error.message }); return; }

  if (isSaasMode()) {
    for (const rule of ROUTE_POLICY) {
      if (rule.method && !new RegExp(`^(${rule.method})$`).test(req.method)) continue;
      if (!rule.path.test(req.path)) continue;
      if (rule.kind === "disabled") { res.status(501).json({ success: false, error: rule.message }); return; }
      const staff = isPlatformStaff(p.role);
      if (rule.kind === "platform_only" && !staff) { res.status(403).json({ success: false, error: rule.message ?? "Platform staff only" }); return; }
      if (rule.kind === "tenant_content" && !isTenantMember(p.role)) { res.status(403).json({ success: false, error: "Platform staff cannot access tenant content" }); return; }
      if (rule.kind === "feature" && !r.features.has(rule.feature!)) {
        res.status(403).json({ success: false, error: `${rule.feature} is disabled`, feature: rule.feature }); return;
      }
      break;
    }
    if (req.method === "POST" && /^\/chat(\/|$)/.test(req.path) && isTenantMember(p.role)) {
      const over = tenantUsesOwnKey(p.tenantId) ? null : quotaExceeded(p.tenantId);
      if (over) { res.status(429).json({ success: false, error: over, quota: true }); return; }
    }
    // A tenant member must never reach a staff-only surface even if the feature is on for them.
    if (isTenantMember(p.role) && STAFF_PREFIXES.some((x) => x.test(req.path))) { res.status(403).json({ success: false, error: "Platform staff only" }); return; }
  } else {
    // Legacy mode: only the feature switches apply.
    for (const rule of ROUTE_POLICY) {
      if (rule.kind !== "feature" || !rule.path.test(req.path)) continue;
      if (!r.features.has(rule.feature!)) { res.status(403).json({ success: false, error: `${rule.feature} is disabled`, feature: rule.feature }); return; }
      break;
    }
  }
  runWithTenant({ tenantId: p.tenantId, userId: p.userId, role: p.role, features: r.features }, next);
}
