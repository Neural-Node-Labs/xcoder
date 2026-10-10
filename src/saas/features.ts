import fs from "node:fs";
import path from "node:path";
import { isPlatformStaff, isSaasMode, DEFAULT_TENANT_ID, type Role } from "./roles.js";
import { saasDataDir, writeJsonAtomic, readJson } from "./storage.js";
import type { Tenant } from "./tenantStore.js";

/**
 * Feature switches. Every module and every risky capability can be turned off, at two levels:
 *   platform  - the SaaS owner (legacy mode: the admin), or a hard env override `XCODER_FEATURE_<ID>=on|off`
 *   tenant    - a per-tenant override: the owner can set any; a tenant admin only the non-sensitive ones
 * A feature is on for a user only if BOTH levels allow it.
 */
export interface FeatureDef {
  id: string;
  label: string;
  description: string;
  kind: "module" | "tool_group" | "integration";
  /** Sensitive features widen what tenant code can reach, so only the platform owner can turn them on for a tenant. */
  sensitive: boolean;
  /** A tenant admin may switch it OFF for their own tenant (and back ON if not sensitive). */
  tenantToggle: boolean;
  /** Backed by ONE shared instance (agent, CodeGraph): usable by platform staff only, never by a tenant. */
  platformOnly: boolean;
  defaultSingle: boolean;
  defaultSaas: boolean;
}

export const FEATURES: FeatureDef[] = [
  { id: "crm", label: "CRM", kind: "module", sensitive: false, tenantToggle: true, platformOnly: false, defaultSingle: true, defaultSaas: true,
    description: "Contacts, companies, deals and activities. Data is private to each tenant." },
  { id: "saas_management", label: "SaaS management console", kind: "module", sensitive: false, tenantToggle: false, platformOnly: true, defaultSingle: false, defaultSaas: true,
    description: "Tenant lifecycle, plans, usage, feature switches and staff for the SaaS owner and operations team." },
  { id: "shell_tools", label: "Shell and remote-execution tools", kind: "tool_group", sensitive: true, tenantToggle: false, platformOnly: false, defaultSingle: true, defaultSaas: false,
    description: "run_command, ssh, docker deploy. These run inside the API container: only enable for a tenant if commands are sandboxed at the infrastructure level." },
  { id: "network_tools", label: "Outbound network tools", kind: "tool_group", sensitive: true, tenantToggle: false, platformOnly: false, defaultSingle: true, defaultSaas: false,
    description: "web search, URL summarising, site crawling, GitHub, API tests. They fetch from the server's network and can reach internal services." },
  { id: "mcp_tools", label: "MCP tools", kind: "tool_group", sensitive: true, tenantToggle: false, platformOnly: false, defaultSingle: true, defaultSaas: false,
    description: "Model Context Protocol servers configured on the platform (shared credentials)." },
  { id: "security_ops", label: "Security Ops", kind: "integration", sensitive: true, tenantToggle: false, platformOnly: false, defaultSingle: true, defaultSaas: false,
    description: "Blue/Red team checks run from the server. The target allowlist is platform-wide." },
  { id: "agi", label: "AGI DevOps agent", kind: "integration", sensitive: true, tenantToggle: false, platformOnly: true, defaultSingle: true, defaultSaas: true,
    description: "The AGI agent. One shared instance (one memory, goal and budget) for platform staff; a tenant only gets it through its own dedicated instance set up by the SaaS owner." },
  { id: "codegraph", label: "CodeGraph", kind: "integration", sensitive: true, tenantToggle: false, platformOnly: true, defaultSingle: true, defaultSaas: true,
    description: "One shared code index with one admin key. Platform staff only in SaaS mode." },
];
export const FEATURE_IDS = FEATURES.map((f) => f.id);
export const featureDef = (id: string) => FEATURES.find((f) => f.id === id);

// ─── platform-level switches ───────────────────────────────────────────────────────
const platformFile = () => path.join(saasDataDir(), "platform.json");
let platformCache: { features: Record<string, boolean> } | null = null;

function platformState() {
  if (!platformCache) {
    const raw = readJson<{ features?: Record<string, unknown> }>(platformFile(), {});
    const features: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(raw.features ?? {})) if (featureDef(k) && typeof v === "boolean") features[k] = v;
    platformCache = { features };
  }
  return platformCache;
}
export function resetFeatureCacheForTests() { platformCache = null; }

/** `XCODER_FEATURE_CRM=off` -> false, `=on` -> true, otherwise undefined. These win over the stored switches. */
export function envOverride(id: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const v = (env[`XCODER_FEATURE_${id.toUpperCase()}`] ?? "").trim().toLowerCase();
  if (/^(0|off|false|no|disabled?)$/.test(v)) return false;
  if (/^(1|on|true|yes|enabled?)$/.test(v)) return true;
  return undefined;
}

export function platformEnabled(id: string): boolean {
  const def = featureDef(id);
  if (!def) return false;
  const env = envOverride(id);
  if (env !== undefined) return env;
  // Platform level answers "may this exist on the deployment at all?". In SaaS mode every feature is available by default;
  // what is OFF-by-default for tenants (shell/network/...) is decided by the tenant level (defaultSaas).
  return platformState().features[id] ?? (isSaasMode() ? true : def.defaultSingle);
}
export function platformLocked(id: string): boolean { return envOverride(id) !== undefined; }

export function setPlatformFeature(id: string, enabled: boolean): string | null {
  if (!featureDef(id)) return `Unknown feature '${id}'`;
  if (platformLocked(id)) return `'${id}' is locked by the XCODER_FEATURE_${id.toUpperCase()} environment variable`;
  const s = platformState();
  s.features[id] = enabled;
  writeJsonAtomic(platformFile(), s);
  return null;
}

// ─── effective, per principal ─────────────────────────────────────────────────────
export function tenantAllows(id: string, tenant: Pick<Tenant, "features"> | undefined): boolean {
  const def = featureDef(id);
  if (!def) return false;
  const o = tenant?.features?.[id];
  return o !== undefined ? o : isSaasMode() ? def.defaultSaas : def.defaultSingle;
}

export function featureEnabledFor(id: string, role: Role | string | undefined, tenant: Pick<Tenant, "features"> | Tenant | undefined): boolean {
  const def = featureDef(id);
  if (!def || !platformEnabled(id)) return false;
  if (!isSaasMode()) return true;                                   // legacy mode: the platform switch is the only one
  if (def.id === "agi" && !isPlatformStaff(role)) return Boolean((tenant as Partial<Tenant> | undefined)?.agi) && tenantAllows(id, tenant); // tenants only via their OWN dedicated instance
  if (def.platformOnly) return isPlatformStaff(role);               // shared instance: staff yes, tenants never
  if (isPlatformStaff(role)) return def.id === "saas_management" || def.kind === "module" ? true : tenantAllows(id, tenant);
  return tenantAllows(id, tenant);
}

export function effectiveFeatures(role: Role | string | undefined, tenant: Pick<Tenant, "features"> | Tenant | undefined): string[] {
  return FEATURE_IDS.filter((id) => featureEnabledFor(id, role, tenant));
}

/** Validate a tenant feature patch from the given actor. Returns an error string or the clean map. */
export function parseTenantFeaturePatch(input: unknown, actorIsOwner: boolean): Record<string, boolean> | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "features must be an object of { featureId: boolean }";
  const out: Record<string, boolean> = {};
  for (const [id, v] of Object.entries(input as Record<string, unknown>)) {
    const def = featureDef(id);
    if (!def) return `Unknown feature '${id}'`;
    if (typeof v !== "boolean") return `Feature '${id}' must be true or false`;
    if (def.platformOnly) return `'${id}' is a platform feature and cannot be set per tenant`;
    if (!actorIsOwner) {
      if (!def.tenantToggle) return `'${id}' can only be changed by the SaaS owner`;
      if (v && def.sensitive) return `'${id}' can only be enabled by the SaaS owner`;
      if (v && !platformEnabled(id)) return `'${id}' is disabled platform-wide`;
    }
    out[id] = v;
  }
  return out;
}

export { DEFAULT_TENANT_ID, fs };
