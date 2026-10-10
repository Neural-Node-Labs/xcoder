import { useCallback, useEffect, useState } from "react";
import { api, CacheStats } from "../api/client";

export const hitRate = (s: Pick<CacheStats, "hits" | "misses">) => (s.hits + s.misses ? Math.round((s.hits / (s.hits + s.misses)) * 100) : null);
export const fmtTtl = (sec: number) => (sec % 86400 === 0 ? `${sec / 86400} d` : sec % 3600 === 0 ? `${sec / 3600} h` : `${Math.round(sec / 60)} min`);

/** Admin-only: shows the LLM response cache (chat + task) status and lets an admin flush it. Hidden for non-admins. */
export function CacheCard() {
  const [s, setS] = useState<CacheStats | null>(null);
  const [hidden, setHidden] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.cacheStats().then((v) => { setS(v); setHidden(false); }).catch((e) => { if (/admin|403|forbidden/i.test(String(e?.message ?? e))) setHidden(true); }), []);
  useEffect(() => { void load(); const id = setInterval(() => void load(), 15_000); return () => clearInterval(id); }, [load]);
  if (hidden || !s) return null;

  const rate = hitRate(s);
  const flush = async () => {
    if (!window.confirm("Clear every cached LLM response? The next requests will call the model again.")) return;
    setBusy(true);
    try { const r = await api.clearCache(); setMsg(`Cleared ${r.removed} cached response${r.removed === 1 ? "" : "s"}.`); await load(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <div className="card" style={{ gridColumn: "1 / -1" }}>
      <div className="card-title">LLM response cache</div>
      {!s.enabled ? (
        <p className="text-2">Off. Set <code>XCODER_REDIS_URL</code> (bundled Redis in Docker Compose) to cache identical chat and task model calls.</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <span className={`badge ${s.ready ? "badge-green" : "badge-amber"}`}>{s.backend}: {s.ready ? "connected" : "unavailable — calls go straight to the model"}</span>
            <span className="badge">{s.approxEntries ?? "?"} entries</span>
            <span className="badge">TTL {fmtTtl(s.ttlSeconds)}</span>
          </div>
          <p className="text-2" style={{ margin: "4px 0" }}>
            {s.hits} hits / {s.misses} misses{rate !== null ? ` (${rate}% hit rate)` : ""} since this server started · {s.tokensSaved.toLocaleString("en-US")} tokens saved · {s.bypassed} bypassed (thinking mode or non-deterministic) · {s.errors} errors
          </p>
          <button className="btn btn-sm" disabled={busy || !s.ready} onClick={() => void flush()}>Clear cache</button>
          {msg && <span className="text-2" style={{ marginLeft: 10 }} role="status">{msg}</span>}
        </>
      )}
    </div>
  );
}
