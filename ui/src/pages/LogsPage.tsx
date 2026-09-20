import { useState, useEffect, useRef } from "react";
import { usePageActive, useOnActivate } from "../context/PageActive";
import { api, TelemetryEntry } from "../api/client";

type LogFile = "thinking" | "llm" | "sys";

export function LogsPage() {
  const [logFile, setLogFile] = useState<LogFile>("thinking");
  const [entries, setEntries] = useState<TelemetryEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const active = usePageActive();

  useEffect(() => {
    let cancelled = false;
    async function fetchLogs() {
      try {
        const r = await api.telemetry(logFile, 100);
        if (!cancelled) {
          setEntries(r.entries);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    // Kept mounted while hidden — don't poll the server for a page nobody is looking at.
    if (!active) return;
    fetchLogs();
    const interval = autoRefresh ? setInterval(fetchLogs, 2500) : undefined;
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [logFile, autoRefresh, active]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries]);

  return (
    <div className="card">
      <div className="row-between" style={{ marginBottom: 14 }}>
        <div className="card-title" style={{ margin: 0 }}>
          Live logs
        </div>
        <div className="row" style={{ gap: 10 }}>
          <select style={{ width: 140 }} value={logFile} onChange={(e) => setLogFile(e.target.value as LogFile)}>
            <option value="thinking">thinking.log</option>
            <option value="llm">llm.log</option>
            <option value="sys">sys.log</option>
          </select>
          <label className="row" style={{ gap: 6, fontWeight: 400, fontSize: 12 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh
          </label>
        </div>
      </div>

      {error && <div className="badge badge-red" style={{ marginBottom: 12 }}>{error}</div>}

      {entries.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">▤</div>
          No {logFile} entries yet — run a task to see thought / action / observation appear here live.
        </div>
      ) : (
        <div className="console">
          {entries.map((entry, i) => (
            <div className="console-line" key={i}>
              {entry.timestamp && <span className="ts">{new Date(entry.timestamp).toLocaleTimeString()}</span>}
              {entry.data ? JSON.stringify(entry.data) : String(entry.raw ?? "")}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
