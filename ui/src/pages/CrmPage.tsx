import { useCallback, useEffect, useState } from "react";
import { api, type CrmKind, type CrmRecord, type CrmSummary } from "../api/client";
import { useOnActivate } from "../context/PageActive";

const STAGES = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
type Field = { key: string; label: string; type?: "text" | "number" | "email" | "date" | "select"; options?: string[]; required?: boolean };
const CONFIG: Record<CrmKind, { label: string; title: string; fields: Field[]; cols: string[] }> = {
  contacts: { label: "Contacts", title: "name", cols: ["name", "email", "phone", "title"], fields: [
    { key: "name", label: "Name", required: true }, { key: "email", label: "Email", type: "email" }, { key: "phone", label: "Phone" }, { key: "title", label: "Job title" }, { key: "notes", label: "Notes" }] },
  companies: { label: "Companies", title: "name", cols: ["name", "industry", "website", "phone"], fields: [
    { key: "name", label: "Name", required: true }, { key: "industry", label: "Industry" }, { key: "website", label: "Website" }, { key: "phone", label: "Phone" }, { key: "notes", label: "Notes" }] },
  deals: { label: "Deals", title: "title", cols: ["title", "value", "stage", "closeDate"], fields: [
    { key: "title", label: "Title", required: true }, { key: "value", label: "Value", type: "number" }, { key: "stage", label: "Stage", type: "select", options: STAGES }, { key: "closeDate", label: "Expected close", type: "date" }, { key: "notes", label: "Notes" }] },
  activities: { label: "Activities", title: "subject", cols: ["subject", "type", "dueDate", "done"], fields: [
    { key: "subject", label: "Subject", required: true }, { key: "type", label: "Type", type: "select", options: ["note", "call", "email", "meeting", "task"] }, { key: "dueDate", label: "Due", type: "date" }, { key: "body", label: "Details" }] },
};
const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

export function CrmPage() {
  const [tab, setTab] = useState<"overview" | CrmKind>("overview");
  const [summary, setSummary] = useState<CrmSummary | null>(null);
  const [rows, setRows] = useState<CrmRecord[]>([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setError(null);
    if (tab === "overview") api.crmSummary().then(setSummary).catch((e) => setError(String(e.message ?? e)));
    else api.crmList(tab, search.trim() || undefined).then(setRows).catch((e) => setError(String(e.message ?? e)));
  }, [tab, search]);
  useEffect(refresh, [refresh]);
  useOnActivate(refresh);

  async function add(e: React.FormEvent) {
    e.preventDefault(); if (tab === "overview") return;
    setBusy(true); setError(null);
    try {
      const body: Record<string, unknown> = {};
      for (const f of CONFIG[tab].fields) { const v = form[f.key]; if (v === undefined || v === "") continue; body[f.key] = f.type === "number" ? Number(v) : v; }
      await api.crmCreate(tab, body); setForm({}); refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  }
  async function patch(id: string, b: Record<string, unknown>) { if (tab === "overview") return; try { await api.crmUpdate(tab, id, b); refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }
  async function remove(id: string) { if (tab === "overview" || !confirm("Delete this record?")) return; try { await api.crmDelete(tab, id); refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }

  return (
    <div>
      <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: "wrap" }} role="tablist">
        {(["overview", "contacts", "companies", "deals", "activities"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`btn btn-sm ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>{t === "overview" ? "Pipeline" : CONFIG[t].label}</button>
        ))}
      </div>
      {error && <div className="badge badge-red" role="alert" style={{ marginBottom: 12 }}>{error}</div>}

      {tab === "overview" && summary && (
        <>
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            {[["Contacts", summary.contacts], ["Companies", summary.companies], ["Open pipeline", money(summary.openValue)], ["Won", money(summary.wonValue)]].map(([l, v]) => (
              <div className="card stat" key={String(l)}><div className="stat-label">{l}</div><div className="stat-value">{v}</div></div>
            ))}
          </div>
          <div className="card">
            <div className="card-title">Deals by stage</div>
            <table><thead><tr><th>Stage</th><th>Deals</th><th>Value</th></tr></thead>
              <tbody>{STAGES.map((s) => <tr key={s}><td><span className="badge">{s}</span></td><td>{summary.pipeline[s]?.count ?? 0}</td><td>{money(summary.pipeline[s]?.value ?? 0)}</td></tr>)}</tbody></table>
            <div className="text-2" style={{ marginTop: 8 }}>{summary.openTasks} open task{summary.openTasks === 1 ? "" : "s"}</div>
          </div>
        </>
      )}

      {tab !== "overview" && (
        <div className="grid grid-2" style={{ alignItems: "start" }}>
          <div className="card">
            <div className="card-title">Add {CONFIG[tab].label.toLowerCase().replace(/s$/, "")}</div>
            <form onSubmit={add}>
              {CONFIG[tab].fields.map((f) => (
                <div className="field" key={f.key}>
                  <label htmlFor={`crm-${f.key}`}>{f.label}</label>
                  {f.type === "select"
                    ? <select id={`crm-${f.key}`} value={form[f.key] ?? f.options![0]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>
                    : <input id={`crm-${f.key}`} type={f.type ?? "text"} value={form[f.key] ?? ""} required={f.required} min={f.type === "number" ? 0 : undefined} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />}
                </div>
              ))}
              <button className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : "Add"}</button>
            </form>
          </div>
          <div className="card">
            <div className="card-title-row"><div className="card-title">{CONFIG[tab].label}</div>
              <input aria-label="Search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 200 }} /></div>
            {rows.length === 0 ? <div className="empty-state">Nothing here yet.</div> : (
              <table><thead><tr>{CONFIG[tab].cols.map((c) => <th key={c}>{c}</th>)}<th></th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id}>
                    {CONFIG[tab].cols.map((c) => (
                      <td key={c}>
                        {c === "stage" ? <select aria-label="Stage" value={String(r.stage)} onChange={(e) => patch(r.id, { stage: e.target.value })}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select>
                          : c === "done" ? <input type="checkbox" aria-label="Done" checked={!!r.done} onChange={(e) => patch(r.id, { done: e.target.checked })} />
                          : c === "value" ? money(Number(r.value ?? 0)) : String(r[c] ?? "")}
                      </td>
                    ))}
                    <td><button className="btn btn-sm btn-danger" onClick={() => remove(r.id)}>Delete</button></td>
                  </tr>))}</tbody></table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
