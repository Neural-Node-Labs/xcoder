/**
 * Roles and the SaaS master switch.
 *
 *   XCODER_SAAS_MODE unset/false  single-tenant, exactly as before: roles are "admin" and "user", everything lives
 *                                  in one implicit tenant ("default"), and "platform admin" == "admin".
 *   XCODER_SAAS_MODE=true         multi-tenant:
 *       saas_owner    the SaaS owner. Platform-wide settings, tenant lifecycle, plans, feature switches, staff.
 *                     Has NO access to any tenant's content (projects, files, chats, CRM).
 *       saas_ops      SaaS operations / support. Read tenants and usage, suspend/reactivate, reset a tenant
 *                     admin's password. Cannot change plans or feature switches, cannot delete, no tenant content.
 *       tenant_admin  Administers ONE tenant: its users, its feature switches (within entitlement), usage, audit log.
 *       tenant_user   Uses the product inside ONE tenant.
 *
 * Fail closed: in SaaS mode the legacy "admin"/"user" strings carry no privileges (a startup migration converts them).
 */
export type Role = "saas_owner" | "saas_ops" | "tenant_admin" | "tenant_user" | "admin" | "user";

export const DEFAULT_TENANT_ID = "default";
export const SAAS_ROLES = ["saas_owner", "saas_ops", "tenant_admin", "tenant_user"] as const;
export const TENANT_ROLES = ["tenant_admin", "tenant_user"] as const;

export function isSaasMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.XCODER_SAAS_MODE ?? "").trim());
}

type R = string | undefined;
/** Platform-wide authority: the SaaS owner (SaaS mode) or the single admin (legacy mode). */
export const isPlatformAdmin = (role: R, saas = isSaasMode()) => (saas ? role === "saas_owner" : role === "admin");
/** Owner or operations staff (legacy mode: the admin). */
export const isPlatformStaff = (role: R, saas = isSaasMode()) => (saas ? role === "saas_owner" || role === "saas_ops" : role === "admin");
/** Administers a tenant's own users/settings (legacy mode: the admin). */
export const isTenantAdmin = (role: R, saas = isSaasMode()) => (saas ? role === "tenant_admin" : role === "admin");
/** Belongs to a tenant at all (everyone in legacy mode; only tenant_* roles in SaaS mode). */
export const isTenantMember = (role: R, saas = isSaasMode()) => (saas ? role === "tenant_admin" || role === "tenant_user" : role === "admin" || role === "user");

export const ROLE_LABELS: Record<string, string> = {
  saas_owner: "SaaS owner", saas_ops: "SaaS operations", tenant_admin: "Tenant admin", tenant_user: "Tenant user", admin: "Admin", user: "User",
};
