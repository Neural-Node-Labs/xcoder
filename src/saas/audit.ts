import fs from "node:fs";
import path from "node:path";
import { tenantDir } from "./storage.js";

/** Per-tenant audit trail: one JSONL file per tenant, so one tenant can never read (or flood) another's. */
export interface TenantAuditEntry { id: string; timestamp: string; tenantId: string; actorId: string; actorUsername: string; action: string; summary: string; details?: Record<string, unknown> }
const MAX = 2000;
const fileOf = (tenantId: string) => path.join(tenantDir(tenantId), "audit.jsonl");

export function appendTenantAudit(tenantId: string, e: Omit<TenantAuditEntry, "id" | "timestamp" | "tenantId">): void {
  try {
    const f = fileOf(tenantId);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const entry: TenantAuditEntry = { id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString(), tenantId, ...e };
    fs.appendFileSync(f, JSON.stringify(entry) + "\n", { mode: 0o600 });
    const st = fs.statSync(f);
    if (st.size > 2_000_000) {
      const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-MAX);
      fs.writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 });
    }
  } catch (err) { console.error(`[saas.audit] ${err instanceof Error ? err.message : err}`); }
}

export function readTenantAudit(tenantId: string, limit = 200): TenantAuditEntry[] {
  try {
    const out: TenantAuditEntry[] = [];
    for (const l of fs.readFileSync(fileOf(tenantId), "utf8").split("\n")) { if (!l.trim()) continue; try { const e = JSON.parse(l) as TenantAuditEntry; if (e.tenantId === tenantId) out.push(e); } catch { /* skip */ } }
    return out.slice(-limit).reverse();
  } catch { return []; }
}
