import { useCallback, useEffect, useState } from "react";
import { api, type LlmConnection, type LlmPolicy, type PlatformLlm } from "../api/client";
import { LlmConnectionsPanel } from "../components/LlmConnectionsPanel";

/** Owner/ops: platform default, per-purpose platform overrides and the tenant LLM policy. */
export function SaasLlmTab({ owner }: { owner: boolean }) {
  const [d, setD] = useState<PlatformLlm | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [providers, setProviders] = useState("");
  const load = useCallback(() => { api.saasLlm().then((r) => { setD(r); setProviders(r.policy.allowedProviders.join(", ")); }).catch((e: Error) => setErr(e.message)); }, []);
  useEffect(load, [load]);
  const setPolicy = (p: Partial<LlmPolicy>) => api.saasLlmPolicy(p).then(load).catch((e: Error) => setErr(e.message));
  if (!d) return <div className="card">{err ? <div className="badge badge-red">{err}</div> : <span className="spinner" />}</div>;
  const toggles: [keyof Pick<LlmPolicy, "tenantMayConfigure" | "platformFallback" | "allowPrivateUrls">, string, string][] = [
    ["tenantMayConfigure", "Tenants may configure their own connections", "Off: tenants can only see the connection they use."],
    ["platformFallback", "Tenants may fall back to the platform connection", "Off: a tenant with no connection of its own gets a 'not configured' error."],
    ["allowPrivateUrls", "Allow private/internal provider URLs", "Off (recommended): tenant base URLs must be public https. On lets tenants reach internal hosts."],
  ];
  return (
    <div>
      {err && <div className="badge badge-red" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-title">Tenant LLM policy</div>
        {toggles.map(([k, label, hint]) => (
          <div key={k} style={{ marginBottom: 8 }}>
            <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={d.policy[k]} disabled={!owner} onChange={(e) => setPolicy({ [k]: e.target.checked })} /> {label}</label>
            <div className="field-hint">{hint}</div>
          </div>))}
        <div className="row" style={{ gap: 8 }}>
          <input aria-label="Allowed providers" placeholder="Allowed providers (comma separated, empty = any)" value={providers} disabled={!owner} onChange={(e) => setProviders(e.target.value)} />
          <button className="btn btn-sm" disabled={!owner} onClick={() => setPolicy({ allowedProviders: providers.split(",").map((s) => s.trim()).filter(Boolean) })}>Save</button>
        </div>
        {!owner && <div className="field-hint">Only the SaaS owner can change the policy.</div>}
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-title">Platform default</div>
        {d.default ? <div><span className="mono">{d.default.model}</span> · {d.default.provider} {d.default.base_url ? <span className="text-2">({d.default.base_url})</span> : null} · key {d.default.hasKey ? "set" : "not set"}</div> : <div className="text-2">No platform default configured.</div>}
        <div className="field-hint">Provider and key are managed in Settings. Overrides below apply per purpose to every tenant using the platform connection.</div>
      </div>
      <LlmConnectionsPanel title="Platform overrides" connections={d.overrides} providers={d.providers} slots={["default", "chat", "task", "agi"]} allowPlatformMode={false} readOnly={!owner}
        api={{ save: api.saasLlmSave, remove: api.saasLlmRemove, test: api.saasLlmTest, reload: load }} />
    </div>
  );
}

/** Per-tenant: their connections (reset) and the dedicated AGI instance. */
export function TenantLlmCard({ id, owner }: { id: string; owner: boolean }) {
  const [conns, setConns] = useState<LlmConnection[]>([]);
  const [agi, setAgi] = useState<{ url: string; hasToken: boolean } | null>(null);
  const [url, setUrl] = useState(""); const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { api.saasTenantLlm(id).then((r) => { setConns(r.connections); setAgi(r.agi); setUrl(r.agi?.url ?? ""); }).catch((e: Error) => setErr(e.message)); }, [id]);
  useEffect(load, [load]);
  const act = (fn: () => Promise<unknown>) => { setErr(null); fn().then(load).catch((e: Error) => setErr(e.message)); };
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-title">LLM connections</div>
      {err && <div className="badge badge-red">{err}</div>}
      {conns.length === 0 ? <div className="text-2">Uses the platform connection (no tenant connections).</div> :
        <table><thead><tr><th>Slot</th><th>Mode</th><th>Provider</th><th>Model</th><th>Key</th><th></th></tr></thead><tbody>
          {conns.map((c) => <tr key={c.slot}><td>{c.slot}</td><td>{c.mode}</td><td>{c.provider ?? "—"}</td><td className="mono">{c.model ?? "—"}</td><td>{c.hasKey ? "set" : "—"}</td>
            <td>{owner && <button className="btn btn-sm" onClick={() => confirm(`Reset the ${c.slot} connection?`) && act(() => api.saasTenantLlmReset(id, c.slot))}>Reset</button>}</td></tr>)}
        </tbody></table>}
      <div className="divider" />
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Dedicated AGI instance</div>
      <div className="field-hint" style={{ marginBottom: 8 }}>AGI keeps one memory and budget per instance, so a tenant only gets AGI with its own instance. Deploy it separately, then enter its URL and token.</div>
      {owner ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input aria-label="AGI URL" placeholder="https://agi-acme.internal:7070" value={url} onChange={(e) => setUrl(e.target.value)} style={{ minWidth: 260 }} />
          <input aria-label="AGI token" type="password" placeholder={agi?.hasToken ? "Token set (leave blank to keep)" : "Token"} value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn btn-sm btn-primary" disabled={!url} onClick={() => act(async () => { await api.saasSetTenantAgi(id, { url, ...(token ? { token } : {}) }); setToken(""); })}>{agi ? "Update" : "Enable AGI"}</button>
          {agi && <button className="btn btn-sm btn-danger" onClick={() => act(() => api.saasRemoveTenantAgi(id))}>Remove</button>}
        </div>
      ) : <div className="text-2">{agi ? `Configured: ${agi.url}` : "Not configured."}</div>}
    </div>
  );
}
