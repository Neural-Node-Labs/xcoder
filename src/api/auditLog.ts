import fs from "node:fs";
import path from "node:path";
import { resolveAuditLogJsonlPath } from "../config/paths.js";

/**
 * Append-only audit trail for admin actions — who did what, when. Lives at
 * .agent/logs/audit.jsonl, one JSON object per line, newest last on disk (same convention as
 * core/taskHistory.ts's task-history.jsonl). This is a *server-wide* log, not a per-project
 * one, so every caller in routes.ts passes process.cwd() the same way the /telemetry route
 * already does for thinking.log/sys.log — not resolveProjectCwd()'s per-tenant project path.
 *
 * Deliberately NOT wired into the LLM-facing tool layer (toolSchemas.ts/toolDispatcher.ts) —
 * an audit trail that the audited agent can also read or reason about isn't a strong audit
 * trail. The only way to read this back is GET /api/v1/audit-log, which — like every route
 * that touches it — is admin-only.
 */

export interface AuditLogEntry {
  id: string;
  timestamp: string; // ISO 8601
  actorId: string;
  actorUsername: string;
  /** Short, stable machine-readable action tag, e.g. "user.create", "codegraph.start". Grouped
   *  by dot-namespace so the frontend can filter/color by prefix without a fixed enum here. */
  action: string;
  /** Free-form human-readable one-liner shown in the UI, e.g. "created user 'alice' (admin)". */
  summary: string;
  /** Optional structured detail (ids, before/after values, etc.) for anyone who needs more than
   *  the summary — never includes secrets (passwords, API keys, tokens): callers are expected to
   *  redact those before calling appendAuditLog(), same discipline as everywhere else in this
   *  codebase that logs request bodies. */
  details?: Record<string, unknown>;
}

const MAX_ENTRIES = 5000; // cap file growth; oldest entries drop off on append past this

export function appendAuditLog(
  cwd: string,
  entry: Omit<AuditLogEntry, "id" | "timestamp">
): AuditLogEntry {
  const full: AuditLogEntry = {
    id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };

  const jsonlPath = resolveAuditLogJsonlPath(cwd);
  fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });

  const existing = readAuditLog(cwd, MAX_ENTRIES);
  // readAuditLog returns newest-first; put back in oldest-first order for on-disk storage,
  // append the new entry, then re-cap.
  const oldestFirst = existing.slice().reverse();
  const updated = [...oldestFirst, full].slice(-MAX_ENTRIES);
  fs.writeFileSync(jsonlPath, updated.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");

  return full;
}

/** The most recent `limit` audit entries, newest first. */
export function readAuditLog(cwd: string, limit = 100): AuditLogEntry[] {
  const p = resolveAuditLogJsonlPath(cwd);
  if (!fs.existsSync(p)) return [];

  const lines = fs.readFileSync(p, "utf-8").split("\n").filter((l) => l.trim());
  const entries: AuditLogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip a corrupt line rather than failing the whole read
    }
  }
  return entries.slice(-limit).reverse();
}
