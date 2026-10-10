import type { Request, Response, Router } from "express";
import { hashPassword, revokeTokensForTenant, revokeTokensForUserId, type StoredUser } from "../api/auth.js";
import { appendAuditLog, readAuditLog } from "../api/auditLog.js";
import { appendTenantAudit, readTenantAudit } from "./audit.js";
import { FEATURES, effectiveFeatures, featureDef, parseTenantFeaturePatch, platformEnabled, platformLocked, setPlatformFeature, tenantAllows } from "./features.js";
import { principalOf } from "./gate.js";
import { requirePlatformAdmin, requirePlatformStaff, requireTenantAdmin, requireTenantMember } from "./guards.js";
import { isSaasMode, type Role } from "./roles.js";
import { PLANS, createTenant, effectiveQuota, getTenant, listTenants, setTenantStatus, updateTenant, type Tenant } from "./tenantStore.js";
import { allUsage, getUsage } from "./usage.js";

export interface SaasDeps {
  users: () => StoredUser[];
  persist: () => void;
  newId: () => string;
}

const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });
const fail = (res: Response, status: number, error: string) => res.status(status).json({ success: false, error });
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const pwOk = (p: unknown): p is string => typeof p === "string" && p.length >= 8 && p.length <= 200;
const safeUser = (u: StoredUser) => ({ id: u.id, username: u.username, role: u.role, tenantId: u.tenantId, email: u.email, authProvider: u.authProvider, disabled: !!u.disabled, createdAt: u.createdAt });

export function registerSaasRoutes(router: Router, d: SaasDeps): void {
  const me = (req: Request) => principalOf(req);
  const platformAudit = (req: Request, action: string, summary: string, tenantId?: string, details?: Record<string, unknown>) => {
    const p = me(req)!;
    appendAuditLog(process.cwd(), { actorId: p.userId, actorUsername: p.username, action, summary, details: { ...details, tenantId } });
    if (tenantId) appendTenantAudit(tenantId, { actorId: p.userId, actorUsername: `${p.username} (platform)`, action, summary, details });
  };
  const tenantAudit = (req: Request, action: string, summary: string, details?: Record<string, unknown>) => {
    const p = me(req)!; appendTenantAudit(p.tenantId, { actorId: p.userId, actorUsername: p.username, action, summary, details });
  };
  const nameTaken = (username: string) => d.users().some((u) => u.username.toLowerCase() === username.toLowerCase());
  const tenantUsers = (tenantId: string) => d.users().filter((u) => u.tenantId === tenantId && (u.role === "tenant_admin" || u.role === "tenant_user"));
  const tenantView = (t: Tenant) => ({
    ...t,
    agi: t.agi ? { url: t.agi.url, hasToken: !!t.agi.token } : undefined, // never expose the sealed token
    quota: effectiveQuota(t), usage: getUsage(t.id), users: tenantUsers(t.id).length,
    admins: tenantUsers(t.id).filter((u) => u.role === "tenant_admin").map((u) => u.username),
    effectiveFeatures: effectiveFeatures("tenant_user", t),
  });
  const featureCatalog = (t?: Tenant) => FEATURES.map((f) => ({
    id: f.id, label: f.label, description: f.description, kind: f.kind, sensitive: f.sensitive, platformOnly: f.platformOnly,
    platformEnabled: platformEnabled(f.id), platformLocked: platformLocked(f.id),
    ...(t ? { tenantEnabled: tenantAllows(f.id, t), effective: platformEnabled(f.id) && !f.platformOnly && tenantAllows(f.id, t), canTenantToggle: f.tenantToggle && !f.platformOnly } : {}),
  }));

  // ───────────────────────── SaaS owner / operations ─────────────────────────
  const staff = requirePlatformStaff(me), owner = requirePlatformAdmin(me);
  const needSaas = (_req: Request, res: Response, next: () => void) => (isSaasMode() ? next() : fail(res, 404, "Multi-tenant mode is off (set XCODER_SAAS_MODE=true)"));

  router.get("/saas/overview", needSaas, staff, (_req, res) => {
    const ts = listTenants(); const usage = allUsage();
    ok(res, {
      tenants: ts.length, active: ts.filter((t) => t.status === "active").length, suspended: ts.filter((t) => t.status === "suspended").length,
      users: d.users().filter((u) => u.role === "tenant_admin" || u.role === "tenant_user").length,
      tokensThisMonth: Object.values(usage).reduce((a, u) => a + u.tokens, 0), requestsThisMonth: Object.values(usage).reduce((a, u) => a + u.requests, 0),
      byPlan: Object.fromEntries(Object.keys(PLANS).map((p) => [p, ts.filter((t) => t.plan === p).length])),
    });
  });
  router.get("/saas/plans", needSaas, staff, (_req, res) => ok(res, Object.values(PLANS)));
  router.get("/saas/features", needSaas, staff, (_req, res) => ok(res, featureCatalog()));
  router.put("/saas/features/:id", needSaas, owner, (req, res) => {
    const id = String(req.params.id); const enabled = (req.body as { enabled?: unknown })?.enabled;
    if (typeof enabled !== "boolean") return fail(res, 400, "'enabled' must be true or false");
    const err = setPlatformFeature(id, enabled);
    if (err) return fail(res, featureDef(id) ? 409 : 404, err);
    platformAudit(req, "saas.feature", `${enabled ? "enabled" : "disabled"} '${id}' platform-wide`);
    ok(res, featureCatalog());
  });

  router.get("/saas/tenants", needSaas, staff, (req, res) => ok(res, listTenants(req.query.includeDeleted === "1").map(tenantView)));
  router.get("/saas/tenants/:id", needSaas, staff, (req, res) => {
    const t = getTenant(String(req.params.id)); if (!t) return fail(res, 404, "Tenant not found");
    ok(res, { ...tenantView(t), featureCatalog: featureCatalog(t), userList: tenantUsers(t.id).map(safeUser) });
  });
  router.post("/saas/tenants", needSaas, owner, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const adminUsername = str(b.adminUsername, 64);
    if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(adminUsername)) return fail(res, 400, "adminUsername must be 3-64 chars (letters, digits, _ . @ -)");
    if (!pwOk(b.adminPassword)) return fail(res, 400, "adminPassword must be at least 8 characters");
    if (nameTaken(adminUsername)) return fail(res, 409, "Username unavailable");
    let features: Record<string, boolean> | undefined;
    if (b.features !== undefined) { const f = parseTenantFeaturePatch(b.features, true); if (typeof f === "string") return fail(res, 400, f); features = f; }
    const t = createTenant({ name: str(b.name, 80), plan: str(b.plan, 32) || "free", features });
    if (typeof t === "string") return fail(res, 400, t);
    const admin: StoredUser = { id: d.newId(), username: adminUsername, passwordHash: hashPassword(b.adminPassword), role: "tenant_admin", tenantId: t.id, createdAt: new Date().toISOString(), authProvider: "local" };
    d.users().push(admin); d.persist();
    platformAudit(req, "saas.tenant.create", `created tenant '${t.name}' (${t.id}, ${t.plan})`, t.id, { admin: adminUsername });
    ok(res, tenantView(t), 201);
  });
  router.put("/saas/tenants/:id", needSaas, owner, (req, res) => {
    const id = String(req.params.id); const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof updateTenant>[1] = {};
    if (b.name !== undefined) patch.name = str(b.name, 80);
    if (b.plan !== undefined) patch.plan = str(b.plan, 32);
    if (b.features !== undefined) { const f = parseTenantFeaturePatch(b.features, true); if (typeof f === "string") return fail(res, 400, f); patch.features = f; }
    if (b.quotas !== undefined) {
      if (typeof b.quotas !== "object" || b.quotas === null) return fail(res, 400, "quotas must be an object");
      const q: Record<string, number> = {};
      for (const k of ["maxUsers", "monthlyTokens", "monthlyRequests", "maxProjects"]) { const v = (b.quotas as Record<string, unknown>)[k]; if (v === undefined) continue; if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return fail(res, 400, `quotas.${k} must be a non-negative number`); q[k] = Math.floor(v); }
      patch.quotas = q;
    }
    const t = updateTenant(id, patch); if (typeof t === "string") return fail(res, 404, t);
    platformAudit(req, "saas.tenant.update", `updated tenant '${t.name}'`, id, { fields: Object.keys(patch) });
    ok(res, tenantView(t));
  });
  router.post("/saas/tenants/:id/suspend", needSaas, staff, (req, res) => {
    const id = String(req.params.id); const t = setTenantStatus(id, "suspended", str((req.body as { reason?: string })?.reason, 200));
    if (typeof t === "string") return fail(res, 404, t);
    const n = revokeTokensForTenant(id);
    platformAudit(req, "saas.tenant.suspend", `suspended '${t.name}' (${n} sessions ended)`, id);
    ok(res, tenantView(t));
  });
  router.post("/saas/tenants/:id/reactivate", needSaas, staff, (req, res) => {
    const id = String(req.params.id); const cur = getTenant(id);
    if (!cur || cur.status === "deleted") return fail(res, 404, "Tenant not found");
    const t = setTenantStatus(id, "active"); if (typeof t === "string") return fail(res, 404, t);
    platformAudit(req, "saas.tenant.reactivate", `reactivated '${t.name}'`, id);
    ok(res, tenantView(t));
  });
  /** Soft delete: sessions revoked, accounts disabled, data kept on disk for the retention policy / export. Nothing is purged here. */
  router.delete("/saas/tenants/:id", needSaas, owner, (req, res) => {
    const id = String(req.params.id); const t = setTenantStatus(id, "deleted"); if (typeof t === "string") return fail(res, 404, t);
    revokeTokensForTenant(id);
    for (const u of tenantUsers(id)) u.disabled = true;
    d.persist();
    platformAudit(req, "saas.tenant.delete", `deleted tenant '${t.name}' (soft delete, data retained)`, id);
    ok(res, tenantView(t));
  });
  router.post("/saas/tenants/:id/reset-admin-password", needSaas, staff, (req, res) => {
    const id = String(req.params.id); const b = (req.body ?? {}) as { username?: string; password?: string };
    if (!pwOk(b.password)) return fail(res, 400, "password must be at least 8 characters");
    const t = getTenant(id); if (!t || t.status === "deleted") return fail(res, 404, "Tenant not found");
    const u = tenantUsers(id).find((x) => x.role === "tenant_admin" && x.authProvider === "local" && (!b.username || x.username === b.username));
    if (!u) return fail(res, 404, "No matching tenant admin");
    u.passwordHash = hashPassword(b.password); d.persist(); revokeTokensForUserId(u.id);
    platformAudit(req, "saas.tenant.reset_admin", `reset password of tenant admin '${u.username}'`, id);
    ok(res, { username: u.username });
  });

  // Platform staff accounts (owner only)
  router.get("/saas/staff", needSaas, owner, (_req, res) => ok(res, d.users().filter((u) => u.role === "saas_owner" || u.role === "saas_ops").map(safeUser)));
  router.post("/saas/staff", needSaas, owner, (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>; const username = str(b.username, 64); const role = b.role === "saas_owner" ? "saas_owner" : "saas_ops";
    if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) return fail(res, 400, "username must be 3-64 chars (letters, digits, _ . @ -)");
    if (!pwOk(b.password)) return fail(res, 400, "password must be at least 8 characters");
    if (nameTaken(username)) return fail(res, 409, "Username unavailable");
    const u: StoredUser = { id: d.newId(), username, passwordHash: hashPassword(b.password), role, createdAt: new Date().toISOString(), authProvider: "local" };
    d.users().push(u); d.persist(); platformAudit(req, "saas.staff.create", `created ${role} '${username}'`);
    ok(res, safeUser(u), 201);
  });
  router.put("/saas/staff/:id", needSaas, owner, (req, res) => {
    const u = d.users().find((x) => x.id === req.params.id && (x.role === "saas_owner" || x.role === "saas_ops")); if (!u) return fail(res, 404, "Staff user not found");
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.role !== undefined) {
      const role = b.role === "saas_owner" ? "saas_owner" : b.role === "saas_ops" ? "saas_ops" : null; if (!role) return fail(res, 400, "role must be saas_owner or saas_ops");
      if (u.role === "saas_owner" && role !== "saas_owner" && d.users().filter((x) => x.role === "saas_owner" && !x.disabled).length <= 1) return fail(res, 409, "Cannot demote the last SaaS owner");
      u.role = role;
    }
    if (b.disabled !== undefined) {
      if (b.disabled === true && u.role === "saas_owner" && d.users().filter((x) => x.role === "saas_owner" && !x.disabled).length <= 1) return fail(res, 409, "Cannot disable the last SaaS owner");
      u.disabled = b.disabled === true;
    }
    if (b.password !== undefined) { if (!pwOk(b.password)) return fail(res, 400, "password must be at least 8 characters"); u.passwordHash = hashPassword(b.password); }
    d.persist(); revokeTokensForUserId(u.id); platformAudit(req, "saas.staff.update", `updated staff '${u.username}'`);
    ok(res, safeUser(u));
  });
  router.delete("/saas/staff/:id", needSaas, owner, (req, res) => {
    const i = d.users().findIndex((x) => x.id === req.params.id && (x.role === "saas_owner" || x.role === "saas_ops")); if (i < 0) return fail(res, 404, "Staff user not found");
    const u = d.users()[i];
    if (u.role === "saas_owner" && d.users().filter((x) => x.role === "saas_owner").length <= 1) return fail(res, 409, "Cannot delete the last SaaS owner");
    if (u.id === me(req)!.userId) return fail(res, 409, "You cannot delete your own account");
    d.users().splice(i, 1); d.persist(); revokeTokensForUserId(u.id); platformAudit(req, "saas.staff.delete", `deleted staff '${u.username}'`);
    ok(res, { id: u.id });
  });
  router.get("/saas/audit", needSaas, staff, (req, res) => ok(res, { entries: readAuditLog(process.cwd(), Math.min(1000, Number(req.query.limit) || 200)) }));

  // ───────────────────────────── Tenant admin / tenant user ─────────────────────────────
  const member = requireTenantMember(me), tadmin = requireTenantAdmin(me);
  const myTenant = (req: Request) => getTenant(me(req)!.tenantId)!;

  router.get("/tenant", needSaas, member, (req, res) => {
    const t = myTenant(req); const p = me(req)!;
    ok(res, { id: t.id, name: t.name, plan: t.plan, status: t.status, quota: effectiveQuota(t), usage: getUsage(t.id), users: tenantUsers(t.id).length,
      features: featureCatalog(t).filter((f) => !f.platformOnly), role: p.role });
  });
  router.get("/tenant/users", needSaas, tadmin, (req, res) => ok(res, tenantUsers(me(req)!.tenantId).map(safeUser)));
  router.post("/tenant/users", needSaas, tadmin, (req, res) => {
    const p = me(req)!; const t = myTenant(req); const b = (req.body ?? {}) as Record<string, unknown>;
    const username = str(b.username, 64); const role: Role = b.role === "tenant_admin" ? "tenant_admin" : "tenant_user";
    if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) return fail(res, 400, "username must be 3-64 chars (letters, digits, _ . @ -)");
    const google = b.authProvider === "google"; const email = str(b.email, 200).toLowerCase();
    if (google ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) : !pwOk(b.password)) return fail(res, 400, google ? "A valid email is required for a Google account" : "password must be at least 8 characters");
    if (nameTaken(username) || (google && d.users().some((u) => u.email?.toLowerCase() === email))) return fail(res, 409, "Username or email unavailable");
    if (tenantUsers(t.id).filter((u) => !u.disabled).length >= effectiveQuota(t).maxUsers) return fail(res, 402, `User limit reached for the ${t.plan} plan (${effectiveQuota(t).maxUsers})`);
    const u: StoredUser = { id: d.newId(), username, passwordHash: google ? "" : hashPassword(b.password as string), role, tenantId: p.tenantId, createdAt: new Date().toISOString(), authProvider: google ? "google" : "local", email: google ? email : undefined };
    d.users().push(u); d.persist(); tenantAudit(req, "user.create", `created ${role} '${username}'`);
    ok(res, safeUser(u), 201);
  });
  router.put("/tenant/users/:id", needSaas, tadmin, (req, res) => {
    const p = me(req)!; const u = tenantUsers(p.tenantId).find((x) => x.id === req.params.id); if (!u) return fail(res, 404, "User not found"); // other tenants' ids look identical to "no such user"
    const b = (req.body ?? {}) as Record<string, unknown>;
    const admins = () => tenantUsers(p.tenantId).filter((x) => x.role === "tenant_admin" && !x.disabled).length;
    if (b.role !== undefined) {
      const role = b.role === "tenant_admin" ? "tenant_admin" : b.role === "tenant_user" ? "tenant_user" : null; if (!role) return fail(res, 400, "role must be tenant_admin or tenant_user");
      if (u.role === "tenant_admin" && role === "tenant_user" && admins() <= 1) return fail(res, 409, "A tenant needs at least one admin");
      u.role = role;
    }
    if (b.disabled !== undefined) {
      if (b.disabled === true && u.role === "tenant_admin" && admins() <= 1) return fail(res, 409, "A tenant needs at least one admin");
      if (b.disabled === true && u.id === p.userId) return fail(res, 409, "You cannot disable your own account");
      u.disabled = b.disabled === true;
    }
    if (b.password !== undefined) { if (!pwOk(b.password)) return fail(res, 400, "password must be at least 8 characters"); if (u.authProvider === "google") return fail(res, 400, "Google accounts have no password"); u.passwordHash = hashPassword(b.password); }
    d.persist(); revokeTokensForUserId(u.id); tenantAudit(req, "user.update", `updated '${u.username}' (${u.role}${u.disabled ? ", disabled" : ""})`);
    ok(res, safeUser(u));
  });
  router.delete("/tenant/users/:id", needSaas, tadmin, (req, res) => {
    const p = me(req)!; const u = tenantUsers(p.tenantId).find((x) => x.id === req.params.id); if (!u) return fail(res, 404, "User not found");
    if (u.id === p.userId) return fail(res, 409, "You cannot delete your own account");
    if (u.role === "tenant_admin" && tenantUsers(p.tenantId).filter((x) => x.role === "tenant_admin").length <= 1) return fail(res, 409, "A tenant needs at least one admin");
    d.users().splice(d.users().indexOf(u), 1); d.persist(); revokeTokensForUserId(u.id); tenantAudit(req, "user.delete", `deleted '${u.username}'`);
    ok(res, { id: u.id });
  });
  router.put("/tenant/features", needSaas, tadmin, (req, res) => {
    const patch = parseTenantFeaturePatch((req.body as { features?: unknown })?.features, false); if (typeof patch === "string") return fail(res, 403, patch);
    const t = updateTenant(me(req)!.tenantId, { features: patch }); if (typeof t === "string") return fail(res, 404, t);
    tenantAudit(req, "tenant.features", `changed features: ${Object.entries(patch).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(", ")}`);
    ok(res, featureCatalog(t).filter((f) => !f.platformOnly));
  });
  router.get("/tenant/audit-log", needSaas, tadmin, (req, res) => ok(res, { entries: readTenantAudit(me(req)!.tenantId, Math.min(1000, Number(req.query.limit) || 200)) }));
}
