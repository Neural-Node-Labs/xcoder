import crypto from "node:crypto";
import path from "node:path";
import { requireTenantId } from "../guards.js";
import { readJson, tenantDir, writeJsonAtomic } from "../storage.js";

export type Kind = "contacts" | "companies" | "deals" | "activities";
export const KINDS: Kind[] = ["contacts", "companies", "deals", "activities"];
export const DEAL_STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const;
export const ACTIVITY_TYPES = ["note", "call", "email", "meeting", "task"] as const;

export interface Rec { id: string; createdAt: string; updatedAt: string; createdBy: string; [k: string]: unknown }
type Db = Record<Kind, Rec[]>;

/** Allowed fields per kind. Anything else in a request body is dropped (no mass-assignment of id/createdBy/etc.). */
const FIELDS: Record<Kind, Record<string, "string" | "number" | "boolean">> = {
  contacts: { name: "string", email: "string", phone: "string", title: "string", companyId: "string", notes: "string", tags: "string" },
  companies: { name: "string", website: "string", industry: "string", phone: "string", address: "string", notes: "string" },
  deals: { title: "string", value: "number", currency: "string", stage: "string", contactId: "string", companyId: "string", closeDate: "string", notes: "string" },
  activities: { type: "string", subject: "string", body: "string", dueDate: "string", done: "boolean", contactId: "string", companyId: "string", dealId: "string" },
};
const REQUIRED: Record<Kind, string> = { contacts: "name", companies: "name", deals: "title", activities: "subject" };
const MAX_STR = 5000, MAX_RECORDS = 50_000;

/**
 * Tenant-scoped CRM storage. The tenant is taken from the request's tenant context (never from a parameter the client
 * controls), the file path is derived from the validated tenant id, and requireTenantId() throws if there is no scope,
 * so a bug can only fail closed, never read another tenant's file.
 */
const cache = new Map<string, Db>();
const fileOf = (tid: string) => path.join(tenantDir(tid), "crm.json");
const empty = (): Db => ({ contacts: [], companies: [], deals: [], activities: [] });
function db(): { tid: string; d: Db } {
  const tid = requireTenantId();
  let d = cache.get(tid);
  if (!d) { d = { ...empty(), ...readJson<Partial<Db>>(fileOf(tid), {}) }; cache.set(tid, d); }
  return { tid, d };
}
const save = (tid: string, d: Db) => writeJsonAtomic(fileOf(tid), d);
export function resetCrmCacheForTests() { cache.clear(); }

export function cleanInput(kind: Kind, body: unknown, partial: boolean): Record<string, unknown> | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Body must be an object";
  const b = body as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(FIELDS[kind])) {
    const v = b[k]; if (v === undefined) continue;
    if (t === "number") { if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return `'${k}' must be a non-negative number`; out[k] = v; }
    else if (t === "boolean") { if (typeof v !== "boolean") return `'${k}' must be true or false`; out[k] = v; }
    else { if (typeof v !== "string") return `'${k}' must be a string`; if (v.length > MAX_STR) return `'${k}' is too long`; out[k] = v.trim(); }
  }
  if (!partial && !out[REQUIRED[kind]]) return `'${REQUIRED[kind]}' is required`;
  if (partial && REQUIRED[kind] in out && !out[REQUIRED[kind]]) return `'${REQUIRED[kind]}' cannot be empty`;
  if (out.stage !== undefined && !(DEAL_STAGES as readonly string[]).includes(out.stage as string)) return `stage must be one of ${DEAL_STAGES.join(", ")}`;
  if (kind === "deals" && !partial && out.stage === undefined) out.stage = "lead";
  if (kind === "activities") { if (!partial && out.type === undefined) out.type = "note"; if (out.type !== undefined && !(ACTIVITY_TYPES as readonly string[]).includes(out.type as string)) return `type must be one of ${ACTIVITY_TYPES.join(", ")}`; }
  if (out.email !== undefined && out.email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email as string)) return "'email' is not a valid address";
  return out;
}

/** A reference (companyId/contactId/dealId) must point at a record in the SAME tenant. */
function refError(d: Db, data: Record<string, unknown>): string | null {
  const refs: Array<[string, Kind]> = [["companyId", "companies"], ["contactId", "contacts"], ["dealId", "deals"]];
  for (const [f, k] of refs) { const v = data[f]; if (typeof v === "string" && v && !d[k].some((r) => r.id === v)) return `${f} does not exist`; }
  return null;
}

export function list(kind: Kind, q?: { search?: string; filter?: Record<string, string>; limit?: number }): Rec[] {
  const { d } = db(); let rows = d[kind];
  if (q?.search) { const s = q.search.toLowerCase(); rows = rows.filter((r) => Object.values(r).some((v) => typeof v === "string" && v.toLowerCase().includes(s))); }
  for (const [k, v] of Object.entries(q?.filter ?? {})) rows = rows.filter((r) => String(r[k] ?? "") === v);
  return rows.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.min(q?.limit ?? 200, 1000));
}
export const get = (kind: Kind, id: string): Rec | undefined => db().d[kind].find((r) => r.id === id);

export function create(kind: Kind, body: unknown, userId: string): Rec | string {
  const data = cleanInput(kind, body, false); if (typeof data === "string") return data;
  const { tid, d } = db();
  if (d[kind].length >= MAX_RECORDS) return "Record limit reached";
  const err = refError(d, data); if (err) return err;
  const now = new Date().toISOString();
  const r: Rec = { ...data, id: crypto.randomUUID(), createdAt: now, updatedAt: now, createdBy: userId };
  d[kind].push(r); save(tid, d); return r;
}
export function update(kind: Kind, id: string, body: unknown): Rec | string | undefined {
  const { tid, d } = db(); const r = d[kind].find((x) => x.id === id); if (!r) return undefined;
  const data = cleanInput(kind, body, true); if (typeof data === "string") return data;
  const err = refError(d, data); if (err) return err;
  Object.assign(r, data, { updatedAt: new Date().toISOString() }); save(tid, d); return r;
}
export function remove(kind: Kind, id: string): boolean {
  const { tid, d } = db(); const i = d[kind].findIndex((x) => x.id === id); if (i < 0) return false;
  d[kind].splice(i, 1);
  // Drop dangling references so a deleted contact/company/deal never points at a stale id.
  const f = kind === "contacts" ? "contactId" : kind === "companies" ? "companyId" : kind === "deals" ? "dealId" : null;
  if (f) for (const k of KINDS) for (const r of d[k]) if (r[f] === id) delete r[f];
  save(tid, d); return true;
}
export function summary() {
  const { d } = db();
  const byStage = Object.fromEntries(DEAL_STAGES.map((s) => [s, { count: 0, value: 0 }]));
  for (const x of d.deals) { const b = byStage[x.stage as string]; if (b) { b.count++; b.value += Number(x.value ?? 0); } }
  return { contacts: d.contacts.length, companies: d.companies.length, deals: d.deals.length, openTasks: d.activities.filter((a) => a.type === "task" && !a.done).length, pipeline: byStage,
    wonValue: byStage.won.value, openValue: DEAL_STAGES.filter((s) => s !== "won" && s !== "lost").reduce((a, s) => a + byStage[s].value, 0) };
}
