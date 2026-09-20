import { useState, useEffect } from "react";
import { usePageActive, useOnActivate } from "../context/PageActive";
import { api, AuditLogEntry } from "../api/client";

const ACTION_COLOR: Record<string, string> = {
  user: "badge-blue",
  codegraph: "badge-purple",
  security_ops: "badge-amber",
  settings: "badge-red",
};

function badgeClassFor(action: string): string {
  const prefix = action.split(".")[0];
  return ACTION_COLOR[prefix] ?? "badge-accent";
}

export function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const active = usePageActive();

  useEffect(() => {
    let cancelled = false;
    async function fetchLog() {
      try {
        const r = await api.auditLog(200);
        if (!cancelled) {
          setEntries(r.entries);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (!active) return; // kept mounted while hidden — no polling for a page nobody is viewing
    fetchLog();
    const interval = autoRefresh ? setInterval(fetchLog, 5000) : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh, active]);

  const visible = entries.filter((e) => {
    if (!filter.trim()) return true;
    const q = filter.trim().toLowerCase();
    return e.action.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q) || e.actorUsername.toLowerCase().includes(q);
  });

  return (
    <div className="card">
      <div className="row-between" style={{ marginBottom: 14 }}>
        <div className="card-title" style={{ margin: 0 }}>
          Audit log
        </div>
        <div className="row" style={{ gap: 10 }}>
          <input
            style={{ width: 200 }}
            placeholder="Filter by user, action…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="row" style={{ gap: 6, fontWeight: 400, fontSize: 12 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh
          </label>
        </div>
      </div>

      <div className="text-2" style={{ fontSize: 11, marginBottom: 12 }}>
        Every admin-only action — user management, CodeGraph connect/start/stop, Security Ops
        allowlist changes, LLM key updates — is recorded here. Read-only; this trail can't be
        edited or cleared from the UI.
      </div>

      {error && <div className="badge badge-red" style={{ marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <div className="row text-2">
          <span className="spinner" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">▤</div>
          {entries.length === 0 ? "No admin actions recorded yet." : "No entries match that filter."}
        </div>
      ) : (
        <div className="tool-list">
          {visible.map((e) => (
            <div className="tool-row" key={e.id}>
              <div>
                <div className="tool-row-name">
                  <span className={`badge ${badgeClassFor(e.action)}`} style={{ marginRight: 8 }}>
                    {e.action}
                  </span>
                  {e.summary}
                </div>
                <div className="tool-row-desc mono">
                  {new Date(e.timestamp).toLocaleString()} — {e.actorUsername}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
