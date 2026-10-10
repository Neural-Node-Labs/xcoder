import { useCallback, useEffect, useState } from "react";
import type { LlmConnection, LlmConnectionInput, LlmEffective, LlmSlot, LlmTestResult } from "../api/client";

const SLOT_INFO: Record<LlmSlot, { label: string; hint: string }> = {
  default: { label: "Default", hint: "Used for anything below that you have not set separately." },
  chat: { label: "Chat", hint: "The Assistant chat tab." },
  task: { label: "Tasks", hint: "SDLC runs: plan, execute, phases and sub-agents." },
  agi: { label: "AGI agent", hint: "The autonomous DevOps agent. Pushed to the agent's own instance." },
};

export interface LlmPanelApi {
  save(slot: LlmSlot, b: LlmConnectionInput): Promise<unknown>;
  remove(slot: LlmSlot): Promise<unknown>;
  test(slot: LlmSlot): Promise<LlmTestResult>;
  reload(): void;
}

interface Props {
  title?: string;
  connections: LlmConnection[];
  /** What each purpose currently resolves to (tenant view only). */
  effective?: Record<string, LlmEffective>;
  providers: Record<string, { base_url?: string; model: string }>;
  /** Slots that can be edited here (AGI is hidden for tenants without a dedicated instance). */
  slots: LlmSlot[];
  api: LlmPanelApi;
  readOnly?: boolean;
  /** Offer "use the platform's connection" (tenant view). The platform view only has custom overrides. */
  allowPlatformMode?: boolean;
  allowedProviders?: string[];
}

const blank = (c?: LlmConnection): LlmConnectionInput & { apiKey?: string | null } => ({
  mode: c?.mode ?? "custom", provider: c?.provider ?? "", base_url: c?.base_url ?? "", model: c?.model ?? "", max_tokens: c?.max_tokens, temperature: c?.temperature, tier_models: c?.tier_models,
});

export function LlmConnectionsPanel({ title = "LLM connections", connections, effective, providers, slots, api, readOnly, allowPlatformMode = true, allowedProviders = [] }: Props) {
  const [slot, setSlot] = useState<LlmSlot>(slots[0] ?? "default");
  const existing = connections.find((c) => c.slot === slot);
  const [form, setForm] = useState(blank(existing));
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [test, setTest] = useState<LlmTestResult | null>(null);

  useEffect(() => { setForm(blank(connections.find((c) => c.slot === slot))); setKey(""); setMsg(null); setTest(null); }, [slot, connections]);
  const run = useCallback(async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: "ok", text: ok }); api.reload(); } catch (e) { setMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); }
  }, [api]);

  const providerNames = allowedProviders.length ? allowedProviders : Object.keys(providers);
  const custom = form.mode === "custom";
  const num = (v: string): number | undefined => (v === "" ? undefined : Number(v));

  return (
    <div className="card">
      <div className="card-title">{title}</div>
      {effective && (
        <table style={{ marginBottom: 12 }}>
          <thead><tr><th>Purpose</th><th>Currently uses</th></tr></thead>
          <tbody>
            {(["chat", "task", "agi"] as const).filter((p) => slots.includes(p) || p !== "agi").map((p) => {
              const e = effective[p];
              return (
                <tr key={p}><td style={{ fontWeight: 600 }}>{SLOT_INFO[p].label}</td>
                  <td>{!e || !e.available ? <span className="text-2">{e?.error ?? "Not available"}</span> : <>
                    <span className={`badge ${e.ownKey ? "badge-accent" : ""}`}>{e.ownKey ? "your own key" : "platform"}</span>{" "}
                    <span className="mono">{e.model}</span>{e.provider ? <span className="text-2"> · {e.provider}</span> : null}
                    {p === "agi" && !e.explicit && <span className="text-2"> · agent keeps its own defaults until you set one</span>}</>}</td></tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: "wrap" }} role="tablist" aria-label="Connection slot">
        {slots.map((s) => (
          <button key={s} role="tab" aria-selected={slot === s} className={`btn btn-sm ${slot === s ? "btn-primary" : ""}`} onClick={() => setSlot(s)}>
            {SLOT_INFO[s].label}{connections.some((c) => c.slot === s) ? " •" : ""}
          </button>))}
      </div>
      <div className="field-hint" style={{ marginBottom: 8 }}>{SLOT_INFO[slot].hint}</div>

      <form onSubmit={(e) => {
        e.preventDefault();
        const body: LlmConnectionInput = { ...form, ...(key ? { apiKey: key } : {}) };
        if (!custom) { delete body.provider; delete body.base_url; }
        else if (!body.base_url) delete body.base_url;
        if (body.tier_models && !Object.values(body.tier_models).some(Boolean)) delete body.tier_models;
        if (slot !== "agi") delete body.tier_models;
        void run(() => api.save(slot, body), "Saved. It applies from the next request.");
      }}>
        {allowPlatformMode && (
          <div className="field">
            <label htmlFor="llm-mode">Connection</label>
            <select id="llm-mode" value={form.mode} disabled={readOnly} onChange={(e) => setForm({ ...form, mode: e.target.value as "platform" | "custom" })}>
              <option value="platform">Use the platform's connection (optionally choose my own model)</option>
              <option value="custom">Use my own provider and API key</option>
            </select>
          </div>)}

        {custom && (<>
          <div className="field"><label htmlFor="llm-provider">Provider</label>
            <input id="llm-provider" list="llm-provider-list" value={form.provider ?? ""} disabled={readOnly} required onChange={(e) => {
              const p = e.target.value; const d = providers[p];
              setForm({ ...form, provider: p, ...(d && !form.base_url ? { base_url: d.base_url ?? "" } : {}), ...(d && !form.model ? { model: d.model } : {}) });
            }} />
            <datalist id="llm-provider-list">{providerNames.map((p) => <option key={p} value={p} />)}</datalist>
            <div className="field-hint">openai, anthropic, deepseek, openrouter, groq, or any OpenAI-compatible service name.</div></div>
          {form.provider !== "anthropic" && (
            <div className="field"><label htmlFor="llm-url">Base URL</label>
              <input id="llm-url" value={form.base_url ?? ""} disabled={readOnly} placeholder="https://api.openai.com/v1" onChange={(e) => setForm({ ...form, base_url: e.target.value })} />
              <div className="field-hint">Must be https and publicly reachable. Private addresses are refused unless the platform owner allows them.</div></div>)}
          <div className="field"><label htmlFor="llm-key">API key</label>
            <input id="llm-key" type="password" autoComplete="new-password" value={key} disabled={readOnly} placeholder={existing?.hasKey ? "•••••••• saved. Type to replace" : "Paste your key"} onChange={(e) => setKey(e.target.value)} />
            <div className="field-hint">Stored encrypted. It is never shown again and never sent to the browser.</div></div>
        </>)}

        <div className="field"><label htmlFor="llm-model">Model{custom ? "" : " (optional)"}</label>
          <input id="llm-model" value={form.model ?? ""} disabled={readOnly} required={custom} onChange={(e) => setForm({ ...form, model: e.target.value })} /></div>

        {slot === "agi" && (
          <div className="field"><label>Model per difficulty (optional)</label>
            <div className="row" style={{ gap: 8 }}>
              {(["easy", "medium", "hard"] as const).map((t) => (
                <input key={t} aria-label={`${t} model`} placeholder={t} value={form.tier_models?.[t] ?? ""} disabled={readOnly} onChange={(e) => setForm({ ...form, tier_models: { ...form.tier_models, [t]: e.target.value } })} />))}
            </div>
            <div className="field-hint">The agent sends simple steps to the easy model and hard ones to the hard model. Empty = the model above.</div></div>)}

        <div className="row" style={{ gap: 8 }}>
          <div className="field" style={{ flex: 1 }}><label htmlFor="llm-temp">Temperature</label>
            <input id="llm-temp" type="number" step="0.1" min={0} max={2} value={form.temperature ?? ""} disabled={readOnly} onChange={(e) => setForm({ ...form, temperature: num(e.target.value) })} /></div>
          <div className="field" style={{ flex: 1 }}><label htmlFor="llm-max">Max output tokens</label>
            <input id="llm-max" type="number" min={256} max={200000} value={form.max_tokens ?? ""} disabled={readOnly} onChange={(e) => setForm({ ...form, max_tokens: num(e.target.value) })} /></div>
        </div>

        {msg && <div className={`badge ${msg.kind === "ok" ? "badge-green" : "badge-red"}`} role={msg.kind === "err" ? "alert" : "status"} style={{ marginBottom: 12, display: "flex" }}>{msg.text}</div>}
        {test && <div className={`badge ${test.ok ? "badge-green" : "badge-red"}`} role="status" style={{ marginBottom: 12, display: "flex" }}>{test.ok ? `Connected to ${test.provider} (${test.model}) in ${test.ms} ms` : `Test failed: ${test.error}`}</div>}
        {!readOnly && (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : "Save"}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => { setBusy(true); setTest(null); api.test(slot).then(setTest).catch((e) => setTest({ ok: false, ms: 0, model: "", provider: "", error: e instanceof Error ? e.message : String(e) })).finally(() => setBusy(false)); }}>Test saved connection</button>
            {existing && <button type="button" className="btn btn-danger" disabled={busy} onClick={() => confirm(`Remove the ${SLOT_INFO[slot].label} connection?`) && run(() => api.remove(slot), "Removed.")}>Remove</button>}
          </div>)}
      </form>
    </div>
  );
}
