import path from "node:path";
import { effectiveQuota, getTenant } from "./tenantStore.js";
import { readJson, saasDataDir, writeJsonAtomic } from "./storage.js";

/** Monthly per-tenant usage counters, persisted (debounced) so a restart doesn't hand out a fresh allowance. */
export interface Usage { tokens: number; requests: number }
type Store = Record<string, Record<string, Usage>>; // tenantId -> "YYYY-MM" -> usage

const file = () => path.join(saasDataDir(), "usage.json");
let store: Store | null = null;
let timer: NodeJS.Timeout | null = null;
const load = () => (store ??= readJson<Store>(file(), {}));
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
export function resetUsageForTests() { store = null; if (timer) { clearTimeout(timer); timer = null; } }
export function flushUsage() { if (timer) { clearTimeout(timer); timer = null; } if (store) writeJsonAtomic(file(), store); }
function schedule() { if (!timer) { timer = setTimeout(() => { timer = null; try { flushUsage(); } catch { /* best effort */ } }, 2000); timer.unref(); } }

export function getUsage(tenantId: string, month = monthKey()): Usage { return { ...(load()[tenantId]?.[month] ?? { tokens: 0, requests: 0 }) }; }
export function recordUsage(tenantId: string, d: Partial<Usage>) {
  const m = monthKey(); const t = (load()[tenantId] ??= {}); const u = (t[m] ??= { tokens: 0, requests: 0 });
  u.tokens += Math.max(0, Math.floor(d.tokens ?? 0)); u.requests += Math.max(0, Math.floor(d.requests ?? 0)); schedule();
}
export function allUsage(month = monthKey()): Record<string, Usage> {
  return Object.fromEntries(Object.keys(load()).map((id) => [id, getUsage(id, month)]));
}

/** Returns an error message when the tenant is over its monthly allowance, else null. */
export function quotaExceeded(tenantId: string): string | null {
  const t = getTenant(tenantId); if (!t) return null;
  const q = effectiveQuota(t), u = getUsage(tenantId);
  if (u.tokens >= q.monthlyTokens) return `Monthly token allowance reached (${q.monthlyTokens.toLocaleString()}). Upgrade the plan or wait for the next month.`;
  if (u.requests >= q.monthlyRequests) return `Monthly request allowance reached (${q.monthlyRequests.toLocaleString()}).`;
  return null;
}
