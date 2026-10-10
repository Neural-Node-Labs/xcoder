import type { StoredUser } from "../api/auth.js";
import { isSaasMode } from "./roles.js";

/**
 * One-time conversion when a single-tenant install is switched to SaaS mode. Fail-closed by design:
 *  - if no SaaS owner exists, the OLDEST legacy "admin" becomes the owner (otherwise nobody could administer the platform);
 *  - every other legacy "admin"/"user" keeps its legacy role string, which carries NO privileges in SaaS mode until the
 *    owner moves them into a tenant. Returns true if anything changed.
 */
export function migrateUsersForSaas(users: StoredUser[]): boolean {
  if (!isSaasMode() || users.some((u) => u.role === "saas_owner")) return false;
  const first = users.filter((u) => u.role === "admin").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!first) return false;
  first.role = "saas_owner"; delete first.tenantId;
  return true;
}
