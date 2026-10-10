import { useCallback, useEffect, useState } from "react";
import { api, type FeatureInfo, type PlanInfo, type SaasAuditEntry, type SaasOverview, type TenantDetail, type TenantSummary, type TenantUser } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useOnActivate } from "../context/PageActive";
import { SaasLlmTab, TenantLlmCard } from "./SaasLlm";
import { FeatureSwitches } from "./FeatureSwitches";

type Tab = "overview" | "tenants" | "features" | "llm" | "staff" | "audit";
const statusBadge = (s: string) => (s === "active" ? "badge-green" : s === "suspended" ? "badge-amber" : "badge-red");

export function SaasAdminPage() {
  const { role, saasMode } = useAuth();
  const owner = role === "saas_owner";
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<SaasOverview | null>(null);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [features, setFeatures] = useState<FeatureInfo[]>([]);
  const [staff, setStaff] = useState<TenantUser[]>([]);
  const [audit, setAudit] = useState<SaasAuditEntry[]>([]);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nt, setNt] = useState({ name: "", plan: "free", adminUsername: "", adminPassword: "" });
  const [ns, setNs] = useState({ username: "", password: "", role: "saas_ops" as "saas_ops" | "saas_owner" });
  const [resetPw, setResetPw] = useState("");

  const refresh = useCallback(() => {
    if (!saasMode) return;
    const bad = (e: Error) => setErr(e.message);
    api.saasOverview().then(setOverview).catch(bad);
    api.saasTenants().then(setTenants).catch(bad);
    api.saasPlans().then(setPlans).catch(bad);
    api.saasFeatures().then(setFeatures).catch(bad);
    api.saasAudit().then((r) => setAudit(r.entries)).catch(() => {});
    if (owner) api.saasStaff().then(setStaff).catch(() => {});
  }, [saasMode, owner]);
  useEffect(refresh, [refresh]);
  useOnActivate(refresh);

  const run = async (fn: () => Promise<unknown>, reopen?: string) => {
    setBusy(true); setErr(null);
    try { await fn(); refresh(); if (reopen) setDetail(await api.saasTenant(reopen)); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  if (!saasMode) return <div className="card"><div className="empty-state">Multi-tenant mode is off. Set <span className="mono">XCODER_SAAS_MODE=true</span> and restart to manage tenants.</div></div>;

  return (
    <div>
      <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: "wrap" }} role="tablist">
        {(["overview", "tenants", "features", "llm", ...(owner ? ["staff"] : []), "audit"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`btn btn-sm ${tab === t ? "btn-primary" : ""}`} onClick={() => { setTab(t); setDetail(null); }}>{t === "llm" ? "LLM" : t[0].toUpperCase() + t.slice(1)}</button>))}
      </div>
      {err && <div className="badge badge-red" role="alert" style={{ marginBottom: 12 }}>{err}</div>}

      {tab === "overview" && overview && (
        <div className="grid grid-4">
          {[["Tenants", overview.tenants], ["Active", overview.active], ["Suspended", overview.suspended], ["Tenant users", overview.users], ["Tokens this month", overview.tokensThisMonth.toLocaleString()], ["Requests this month", overview.requestsThisMonth.toLocaleString()],
            ...Object.entries(overview.byPlan).map(([p, n]) => [`${p} plan`, n])].map(([l, v]) => <div className="card stat" key={String(l)}><div className="stat-label">{l}</div><div className="stat-value">{v}</div></div>)}
        </div>
      )}

      {tab === "tenants" && !detail && (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <div className="card">
            <div className="card-title">Tenants</div>
            <table><thead><tr><th>Name</th><th>Plan</th><th>Users</th><th>Tokens</th><th>Status</th></tr></thead><tbody>
              {tenants.map((t) => (
                <tr key={t.id}><td><button className="btn btn-ghost btn-sm" onClick={() => api.saasTenant(t.id).then(setDetail).catch((e) => setErr(e.message))}>{t.name}</button></td>
                  <td>{t.plan}</td><td>{t.users}/{t.quota.maxUsers}</td><td>{t.usage.tokens.toLocaleString()}</td><td><span className={`badge ${statusBadge(t.status)}`}>{t.status}</span></td></tr>))}
            </tbody></table>
          </div>
          {owner && (
            <div className="card">
              <div className="card-title">New tenant</div>
              <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.saasCreateTenant(nt); setNt({ name: "", plan: "free", adminUsername: "", adminPassword: "" }); }); }}>
                <div className="field"><label htmlFor="nt-name">Organization name</label><input id="nt-name" value={nt.name} onChange={(e) => setNt({ ...nt, name: e.target.value })} required /></div>
                <div className="field"><label htmlFor="nt-plan">Plan</label><select id="nt-plan" value={nt.plan} onChange={(e) => setNt({ ...nt, plan: e.target.value })}>{plans.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
                <div className="field"><label htmlFor="nt-user">First admin username</label><input id="nt-user" value={nt.adminUsername} onChange={(e) => setNt({ ...nt, adminUsername: e.target.value })} required /></div>
                <div className="field"><label htmlFor="nt-pw">First admin password (min 8)</label><input id="nt-pw" type="password" minLength={8} value={nt.adminPassword} onChange={(e) => setNt({ ...nt, adminPassword: e.target.value })} required /></div>
                <button className="btn btn-primary" disabled={busy}>Create tenant</button>
              </form>
            </div>)}
        </div>
      )}

      {tab === "tenants" && detail && (
        <div>
          <button className="btn btn-sm" onClick={() => setDetail(null)}>← All tenants</button>
          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-title-row"><div className="card-title">{detail.name} <span className={`badge ${statusBadge(detail.status)}`}>{detail.status}</span></div>
              <div className="row" style={{ gap: 6 }}>
                {detail.status === "active" && <button className="btn btn-sm" disabled={busy} onClick={() => { const reason = prompt("Reason for suspension (shown to the tenant)") ?? undefined; void run(() => api.saasSuspend(detail.id, reason), detail.id); }}>Suspend</button>}
                {detail.status === "suspended" && <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.saasReactivate(detail.id), detail.id)}>Reactivate</button>}
                {owner && detail.status !== "deleted" && <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => confirm(`Delete ${detail.name}? Accounts are disabled; data is retained.`) && run(async () => { await api.saasDeleteTenant(detail.id); setDetail(null); })}>Delete</button>}
              </div></div>
            <div className="text-2">{detail.users} users · {detail.usage.tokens.toLocaleString()} / {detail.quota.monthlyTokens.toLocaleString()} tokens · {detail.usage.requests.toLocaleString()} / {detail.quota.monthlyRequests.toLocaleString()} requests · admins: {detail.admins.join(", ") || "none"}</div>
            {owner && (
              <div className="row" style={{ gap: 8, marginTop: 12 }}>
                <label htmlFor="plan-sel">Plan</label>
                <select id="plan-sel" value={detail.plan} disabled={busy} onChange={(e) => run(() => api.saasUpdateTenant(detail.id, { plan: e.target.value }), detail.id)}>{plans.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
              </div>)}
            <div className="divider" />
            <div className="row" style={{ gap: 8 }}>
              <input type="password" aria-label="New admin password" placeholder="New admin password (min 8)" value={resetPw} onChange={(e) => setResetPw(e.target.value)} style={{ maxWidth: 260 }} />
              <button className="btn btn-sm" disabled={busy || resetPw.length < 8} onClick={() => run(async () => { await api.saasResetAdmin(detail.id, resetPw); setResetPw(""); })}>Reset tenant admin password</button>
            </div>
          </div>
          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-title">Feature switches for this tenant</div>
            <FeatureSwitches features={detail.featureCatalog} mode="tenant-owner" busy={busy || !owner} onToggle={(id, enabled) => run(() => api.saasUpdateTenant(detail.id, { features: { [id]: enabled } }), detail.id)} />
            {!owner && <div className="field-hint">Only the SaaS owner can change tenant features.</div>}
          </div>
          <TenantLlmCard id={detail.id} owner={owner} />
        </div>
      )}

      {tab === "llm" && <SaasLlmTab owner={owner} />}

      {tab === "features" && (
        <div className="card">
          <div className="card-title">Platform-wide switches</div>
          <div className="field-hint" style={{ marginBottom: 8 }}>A feature must be on here <em>and</em> for the tenant. Sensitive features are off for tenants by default.</div>
          <FeatureSwitches features={features} mode="platform" busy={busy || !owner} onToggle={(id, enabled) => run(() => api.saasSetFeature(id, enabled))} />
        </div>
      )}

      {tab === "staff" && owner && (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <div className="card"><div className="card-title">Platform staff</div>
            <table><thead><tr><th>User</th><th>Role</th><th></th></tr></thead><tbody>
              {staff.map((u) => <tr key={u.id}><td style={{ fontWeight: 600 }}>{u.username}{u.disabled && <span className="badge badge-red" style={{ marginLeft: 6 }}>disabled</span>}</td><td><span className="badge">{u.role.replace("saas_", "")}</span></td>
                <td><div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                  <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.saasUpdateStaff(u.id, { disabled: !u.disabled }))}>{u.disabled ? "Enable" : "Disable"}</button>
                  <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => confirm(`Delete ${u.username}?`) && run(() => api.saasDeleteStaff(u.id))}>Delete</button></div></td></tr>)}
            </tbody></table></div>
          <div className="card"><div className="card-title">Add staff</div>
            <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.saasCreateStaff(ns); setNs({ username: "", password: "", role: "saas_ops" }); }); }}>
              <div className="field"><label htmlFor="ns-u">Username</label><input id="ns-u" value={ns.username} onChange={(e) => setNs({ ...ns, username: e.target.value })} required /></div>
              <div className="field"><label htmlFor="ns-p">Password (min 8)</label><input id="ns-p" type="password" minLength={8} value={ns.password} onChange={(e) => setNs({ ...ns, password: e.target.value })} required /></div>
              <div className="field"><label htmlFor="ns-r">Role</label><select id="ns-r" value={ns.role} onChange={(e) => setNs({ ...ns, role: e.target.value as "saas_ops" | "saas_owner" })}><option value="saas_ops">Operations</option><option value="saas_owner">Owner</option></select>
                <div className="field-hint">Operations can view tenants and usage, suspend/reactivate and reset a tenant admin's password. They cannot change plans or switches, delete, or see any tenant's data.</div></div>
              <button className="btn btn-primary" disabled={busy}>Add</button>
            </form></div>
        </div>
      )}

      {tab === "audit" && (
        <div className="card"><div className="card-title">Platform audit</div>
          {audit.length === 0 ? <div className="empty-state">No entries.</div> : <table><tbody>{audit.slice(0, 100).map((a) => <tr key={a.id}><td className="text-2" style={{ whiteSpace: "nowrap" }}>{new Date(a.timestamp).toLocaleString()}</td><td>{a.actorUsername}</td><td>{a.summary}</td></tr>)}</tbody></table>}</div>
      )}
    </div>
  );
}
