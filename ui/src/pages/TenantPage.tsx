import { useCallback, useEffect, useState } from "react";
import { api, type FeatureInfo, type MyTenant, type SaasAuditEntry, type TenantUser } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useOnActivate } from "../context/PageActive";
import { FeatureSwitches } from "./FeatureSwitches";

const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 100);

export function TenantPage() {
  const { role, saasMode } = useAuth();
  const admin = role === "tenant_admin" || (!saasMode && role === "admin");
  const [t, setT] = useState<MyTenant | null>(null);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [audit, setAudit] = useState<SaasAuditEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [nu, setNu] = useState({ username: "", password: "", role: "tenant_user" as "tenant_user" | "tenant_admin" });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!saasMode) return;
    api.myTenant().then(setT).catch((e) => setErr(e.message));
    if (admin) { api.tenantUsers().then(setUsers).catch(() => {}); api.tenantAudit().then((r) => setAudit(r.entries)).catch(() => {}); }
  }, [saasMode, admin]);
  useEffect(refresh, [refresh]);
  useOnActivate(refresh);

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); refresh(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };

  if (!saasMode) return <div className="card"><div className="empty-state">Multi-tenant mode is off. Set <span className="mono">XCODER_SAAS_MODE=true</span> to enable organizations.</div></div>;
  if (!t) return <div className="card">{err ? <div className="badge badge-red" role="alert">{err}</div> : <span className="spinner" />}</div>;

  return (
    <div>
      {err && <div className="badge badge-red" role="alert" style={{ marginBottom: 12 }}>{err}</div>}
      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card stat"><div className="stat-label">Organization</div><div className="stat-value" style={{ fontSize: 20 }}>{t.name}</div><div className="stat-sub">{t.plan} plan · {t.status}</div></div>
        <div className="card stat"><div className="stat-label">Tokens this month</div><div className="stat-value">{t.usage.tokens.toLocaleString()}</div>
          <div className="progress-bar-track" role="progressbar" aria-valuenow={pct(t.usage.tokens, t.quota.monthlyTokens)} aria-valuemin={0} aria-valuemax={100}><div className="progress-bar-fill" style={{ width: `${pct(t.usage.tokens, t.quota.monthlyTokens)}%` }} /></div>
          <div className="stat-sub">of {t.quota.monthlyTokens.toLocaleString()}</div></div>
        <div className="card stat"><div className="stat-label">Users</div><div className="stat-value">{t.users} / {t.quota.maxUsers}</div><div className="stat-sub">{t.usage.requests.toLocaleString()} of {t.quota.monthlyRequests.toLocaleString()} requests used</div></div>
      </div>

      {admin && (
        <div className="grid grid-2" style={{ alignItems: "start", marginBottom: 16 }}>
          <div className="card">
            <div className="card-title">Users</div>
            <table><thead><tr><th>User</th><th>Role</th><th></th></tr></thead><tbody>
              {users.map((u) => (
                <tr key={u.id}><td style={{ fontWeight: 600 }}>{u.username}{u.disabled && <span className="badge badge-red" style={{ marginLeft: 6 }}>disabled</span>}</td>
                  <td><span className={`badge ${u.role === "tenant_admin" ? "badge-accent" : ""}`}>{u.role.replace("tenant_", "")}</span></td>
                  <td><div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                    <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.tenantUpdateUser(u.id, { role: u.role === "tenant_admin" ? "tenant_user" : "tenant_admin" }))}>Make {u.role === "tenant_admin" ? "user" : "admin"}</button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.tenantUpdateUser(u.id, { disabled: !u.disabled }))}>{u.disabled ? "Enable" : "Disable"}</button>
                    <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => confirm(`Delete ${u.username}?`) && run(() => api.tenantDeleteUser(u.id))}>Delete</button>
                  </div></td></tr>))}
            </tbody></table>
            <div className="divider" />
            <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.tenantCreateUser({ ...nu }); setNu({ username: "", password: "", role: "tenant_user" }); }); }}>
              <div className="field"><label htmlFor="tu-name">Username</label><input id="tu-name" value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} required /></div>
              <div className="field"><label htmlFor="tu-pw">Password (min 8)</label><input id="tu-pw" type="password" minLength={8} value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} required /></div>
              <div className="field"><label htmlFor="tu-role">Role</label><select id="tu-role" value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as "tenant_user" | "tenant_admin" })}><option value="tenant_user">user</option><option value="tenant_admin">admin</option></select></div>
              <button className="btn btn-primary" disabled={busy}>Add user</button>
            </form>
          </div>
          <div className="card">
            <div className="card-title">Audit trail</div>
            {audit.length === 0 ? <div className="empty-state">No activity yet.</div> : (
              <table><tbody>{audit.slice(0, 30).map((a) => <tr key={a.id}><td className="text-2" style={{ whiteSpace: "nowrap" }}>{new Date(a.timestamp).toLocaleString()}</td><td>{a.actorUsername}</td><td>{a.summary}</td></tr>)}</tbody></table>)}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">Features</div>
        <FeatureSwitches features={t.features as FeatureInfo[]} mode={admin ? "tenant-admin" : "tenant-owner"} busy={busy || !admin}
          onToggle={(id, enabled) => run(() => api.tenantSetFeatures({ [id]: enabled }))} />
        {!admin && <div className="field-hint">Only your organization's admins can change these.</div>}
      </div>
    </div>
  );
}
