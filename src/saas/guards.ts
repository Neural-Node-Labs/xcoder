import type { Request, Response, NextFunction } from "express";
import { runWithTenant, currentTenant } from "./context.js";
import { effectiveFeatures, featureEnabledFor, featureDef } from "./features.js";
import { DEFAULT_TENANT_ID, isPlatformAdmin, isPlatformStaff, isSaasMode, isTenantAdmin, isTenantMember, type Role } from "./roles.js";
import { getTenant } from "./tenantStore.js";

export interface Principal { userId: string; username: string; role: Role; tenantId: string }

/** Resolve tenant state for a principal. Returns an error (status+message) if the tenant may not act. */
export function resolveTenant(p: Principal): { error?: { status: number; message: string }; features: Set<string> } {
  if (!isSaasMode()) return { features: new Set(effectiveFeatures(p.role, undefined)) };
  if (isPlatformStaff(p.role)) return { features: new Set(effectiveFeatures(p.role, undefined)) };
  const t = getTenant(p.tenantId);
  if (!t || t.status === "deleted") return { error: { status: 403, message: "Tenant not found" }, features: new Set() };
  if (t.status === "suspended") return { error: { status: 403, message: `Tenant suspended${t.suspendedReason ? `: ${t.suspendedReason}` : ""}` }, features: new Set() };
  return { features: new Set(effectiveFeatures(p.role, t)) };
}

/** Wrap a handler so the whole async call tree runs with the caller's tenant context. */
export function withTenantContext(p: Principal, fn: () => void, res: Response): void {
  const r = resolveTenant(p);
  if (r.error) { res.status(r.error.status).json({ error: r.error.message }); return; }
  runWithTenant({ tenantId: p.tenantId || DEFAULT_TENANT_ID, userId: p.userId, role: p.role, features: r.features }, fn);
}

export type Getter = (req: Request) => Principal | undefined;

export const requireFeature = (get: Getter, id: string) => (req: Request, res: Response, next: NextFunction) => {
  const p = get(req);
  if (!p) return void res.status(401).json({ error: "Unauthorized" });
  const r = resolveTenant(p);
  if (r.error) return void res.status(r.error.status).json({ error: r.error.message });
  if (!r.features.has(id)) return void res.status(403).json({ error: `${featureDef(id)?.label ?? id} is disabled`, feature: id });
  next();
};

const guard = (get: Getter, ok: (r: string) => boolean, msg: string) => (req: Request, res: Response, next: NextFunction) => {
  const p = get(req);
  if (!p) return void res.status(401).json({ error: "Unauthorized" });
  if (!ok(p.role)) return void res.status(403).json({ error: msg });
  next();
};
export const requirePlatformAdmin = (g: Getter) => guard(g, (r) => isPlatformAdmin(r), "SaaS owner access required");
export const requirePlatformStaff = (g: Getter) => guard(g, (r) => isPlatformStaff(r), "SaaS staff access required");
export const requireTenantAdmin = (g: Getter) => guard(g, (r) => isTenantAdmin(r), "Tenant admin access required");
/** Tenant-scoped data routes: platform staff have no business in a tenant's content. */
export const requireTenantMember = (g: Getter) => guard(g, (r) => isTenantMember(r), "Tenant membership required");

/** Throws if called outside a tenant-scoped request: stores use it so a missing scope can never fall through to shared data. */
export function requireTenantId(): string {
  const c = currentTenant();
  if (c) return c.tenantId;
  if (!isSaasMode()) return DEFAULT_TENANT_ID;
  throw new Error("tenant context missing");
}
export { featureEnabledFor };
