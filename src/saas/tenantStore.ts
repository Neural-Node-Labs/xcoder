import crypto from "node:crypto";
import path from "node:path";
import { DEFAULT_TENANT_ID } from "./roles.js";
import { readJson, saasDataDir, writeJsonAtomic, TENANT_ID_RE } from "./storage.js";

export type TenantStatus = "active" | "suspended" | "deleted";

export interface PlanDef { id: string; label: string; maxUsers: number; monthlyTokens: number; monthlyRequests: number; maxProjects: number }
export const PLANS: Record<string, PlanDef> = {
  free:       { id: "free",       label: "Free",       maxUsers: 3,    monthlyTokens: 200_000,    monthlyRequests: 500,     maxProjects: 3 },
  pro:        { id: "pro",        label: "Pro",        maxUsers: 25,   monthlyTokens: 5_000_000,  monthlyRequests: 20_000,  maxProjects: 50 },
  enterprise: { id: "enterprise", label: "Enterprise", maxUsers: 1000, monthlyTokens: 100_000_000, monthlyRequests: 1_000_000, maxProjects: 1000 },
};

export interface Tenant {
  id: string;
  name: string;
  plan: string;
  status: TenantStatus;
  /** Per-tenant feature overrides (absent = platform default). */
  features: Record<string, boolean>;
  /** Optional per-tenant quota overrides on top of the plan. */
  quotas?: Partial<Omit<PlanDef, "id" | "label">>;
  createdAt: string;
  updatedAt: string;
  /** Dedicated AGI instance for this tenant (owner-set). Token is sealed (AES-GCM); never returned by any API. */
  agi?: { url: string; token?: import("../llm/secretBox.js").Sealed };
  suspendedReason?: string;
  deletedAt?: string;
}

const file = () => path.join(saasDataDir(), "tenants.json");
let cache: Record<string, Tenant> | null = null;
const load = () => (cache ??= readJson<Record<string, Tenant>>(file(), {}));
const save = () => writeJsonAtomic(file(), load());
export function resetTenantCacheForTests() { cache = null; }

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  return s.length >= 2 ? s : `t-${s || "x"}`;
}

export function getTenant(id: string | undefined): Tenant | undefined {
  if (!id) return undefined;
  if (id === DEFAULT_TENANT_ID && !load()[id]) {
    return { id, name: "Default", plan: "enterprise", status: "active", features: {}, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  }
  return load()[id];
}
export const listTenants = (includeDeleted = false) =>
  Object.values(load()).filter((t) => includeDeleted || t.status !== "deleted").sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function createTenant(input: { name: string; plan?: string; features?: Record<string, boolean> }): Tenant | string {
  const name = (input.name ?? "").trim();
  if (name.length < 2 || name.length > 80) return "Tenant name must be 2-80 characters";
  const plan = input.plan ?? "free";
  if (!PLANS[plan]) return `Unknown plan '${plan}'`;
  let id = slugify(name);
  if (load()[id] || id === DEFAULT_TENANT_ID) id = `${id}-${crypto.randomBytes(3).toString("hex")}`;
  if (!TENANT_ID_RE.test(id)) id = `t-${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();
  const t: Tenant = { id, name, plan, status: "active", features: { ...(input.features ?? {}) }, createdAt: now, updatedAt: now };
  load()[id] = t; save();
  return t;
}

export function updateTenant(id: string, patch: Partial<Pick<Tenant, "name" | "plan" | "quotas" | "features">>): Tenant | string {
  const t = load()[id];
  if (!t || t.status === "deleted") return "Tenant not found";
  if (patch.name !== undefined) { const n = patch.name.trim(); if (n.length < 2 || n.length > 80) return "Tenant name must be 2-80 characters"; t.name = n; }
  if (patch.plan !== undefined) { if (!PLANS[patch.plan]) return `Unknown plan '${patch.plan}'`; t.plan = patch.plan; }
  if (patch.quotas !== undefined) t.quotas = patch.quotas;
  if (patch.features !== undefined) t.features = { ...t.features, ...patch.features };
  t.updatedAt = new Date().toISOString(); save();
  return t;
}

export function setTenantStatus(id: string, status: TenantStatus, reason?: string): Tenant | string {
  const t = load()[id];
  if (!t) return "Tenant not found";
  if (t.status === "deleted" && status !== "deleted") return "Tenant is deleted";
  t.status = status;
  t.suspendedReason = status === "suspended" ? (reason ?? "").slice(0, 200) : undefined;
  if (status === "deleted") t.deletedAt = new Date().toISOString();
  t.updatedAt = new Date().toISOString(); save();
  return t;
}

export function setTenantAgi(id: string, agi: Tenant["agi"] | null): Tenant | string {
  const t = load()[id];
  if (!t || t.status === "deleted") return "Tenant not found";
  if (agi === null) { delete t.agi; if (t.features) t.features.agi = false; } else { t.agi = agi; t.features = { ...t.features, agi: true }; }
  t.updatedAt = new Date().toISOString(); save();
  return t;
}

export function effectiveQuota(t: Tenant): PlanDef {
  return { ...(PLANS[t.plan] ?? PLANS.free), ...(t.quotas ?? {}) } as PlanDef;
}
