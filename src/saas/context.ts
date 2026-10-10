import { AsyncLocalStorage } from "node:async_hooks";
import type { Role } from "./roles.js";

/** Who is acting and for which tenant, carried through every async step of a request (LLM calls, tools, stores). */
export interface TenantContext {
  tenantId: string;
  userId: string;
  role: Role;
  /** Effective feature switches for this principal, resolved once per request. */
  features: ReadonlySet<string>;
}

const als = new AsyncLocalStorage<TenantContext>();
export const runWithTenant = <T>(ctx: TenantContext, fn: () => T): T => als.run(ctx, fn);
export const currentTenant = (): TenantContext | undefined => als.getStore();
export const currentTenantId = (): string | undefined => als.getStore()?.tenantId;
