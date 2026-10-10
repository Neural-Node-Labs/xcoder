import type { Role } from "./api/client";

export type PageKey = "dashboard" | "wbs" | "history" | "skills" | "projects" | "workspace" | "tools" | "codegraph" | "secops" | "logs" | "users" | "auditlog" | "settings" | "crm" | "saas" | "tenant";

export interface Access { role: Role | null; saasMode: boolean; features?: string[] }

const isStaff = (r: Role | null) => r === "saas_owner" || r === "saas_ops";
export const isOwner = (r: Role | null, saas: boolean) => (saas ? r === "saas_owner" : r === "admin");
export const isAdminLike = (r: Role | null) => r === "admin" || r === "saas_owner" || r === "tenant_admin";

/**
 * Which pages a principal sees. This is navigation only: the server enforces every rule independently (src/saas/gate.ts),
 * so hiding a page is a courtesy, never the control. `features` undefined means "unknown yet" -> don't hide on that basis.
 */
export function canSee(page: PageKey, a: Access): boolean {
  const has = (f: string) => a.features === undefined || a.features.includes(f);
  if (!a.saasMode) {
    if (page === "users" || page === "auditlog") return a.role === "admin";
    if (page === "crm") return has("crm");
    if (page === "secops") return has("security_ops");
    if (page === "codegraph") return has("codegraph");
    if (page === "saas" || page === "tenant") return false;
    return true;
  }
  if (isStaff(a.role)) {
    if (page === "saas") return has("saas_management");
    if (page === "auditlog") return a.role === "saas_owner";
    return page === "settings" || page === "tools" || page === "skills" || (page === "codegraph" && has("codegraph"));
  }
  // tenant members
  if (page === "saas" || page === "users" || page === "auditlog") return false;
  if (page === "crm") return has("crm");
  if (page === "secops") return has("security_ops");
  if (page === "codegraph") return false;
  return true;
}

export const defaultPage = (a: Access): PageKey => (a.saasMode && isStaff(a.role) ? "saas" : "dashboard");
