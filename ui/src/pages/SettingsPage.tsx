import { useState, useEffect } from "react";
import { api, HealthResponse, EnginesResponse, LlmConfigSummary, LlmProviderDefault } from "../api/client";

export function SettingsPage() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [engines, setEngines] = useState<EnginesResponse | null>(null);

  const [llmConfig, setLlmConfig] = useState<LlmConfigSummary | null>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, LlmProviderDefault>>({});
  const [defaultProvider, setDefaultProvider] = useState("ollama");
  const [form, setForm] = useState<Partial<LlmConfigSummary>>({});
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmMessage, setLlmMessage] = useState<string | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);

  useEffect(() => {
    api.llmKeyStatus().then((r) => setHasKey(r.hasKey)).catch(() => setHasKey(false));
    api.health().then(setHealth).catch(() => {});
    api.engines().then(setEngines).catch(() => {});
    api.llmConfig().then((c) => { setLlmConfig(c); setForm(c); }).catch(() => {});
    api.llmProviders().then((r) => { setProviders(r.providers); setProviderDefaults(r.defaults); setDefaultProvider(r.default); }).catch(() => {});
  }, []);

  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.setLlmKey(keyInput.trim());
      setHasKey(true);
      setKeyInput("");
      setMessage("API key saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearKey() {
    if (!confirm("Remove the stored LLM API key?")) return;
    await api.clearLlmKey();
    setHasKey(false);
  }

  function selectProvider(provider: string) {
    const preset = providerDefaults[provider];
    setForm((f) => ({
      ...f,
      provider,
      model: preset?.model ?? f.model,
      base_url: preset?.base_url ?? "",
      api_key_env: preset?.api_key_env ?? "",
    }));
  }

  async function saveLlmConfig(e: React.FormEvent) {
    e.preventDefault();
    setLlmBusy(true);
    setLlmMessage(null);
    setLlmError(null);
    try {
      const updated = await api.updateLlmConfig(form);
      setLlmConfig(updated);
      setForm(updated);
      setLlmMessage(`Now using ${updated.provider} (${updated.model}) — takes effect on your very next request, no restart needed.`);
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : String(err));
    } finally {
      setLlmBusy(false);
    }
  }

  const isKnownProvider = form.provider ? providers.includes(form.provider) : false;
  const requiresKey = form.provider !== "ollama";

  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <div className="card">
        <div className="card-title">LLM provider</div>
        <p className="text-2" style={{ marginTop: 0, marginBottom: 16, fontSize: 12 }}>
          Edits <code className="mono">agent/config/llm.yaml</code> directly (comments and{" "}
          <code className="mono">overrides</code>/<code className="mono">fallback</code> sections are left
          untouched). <strong>{defaultProvider}</strong> is xcoder's shipped default — runs fully local, no API
          key needed.
        </p>
        {!llmConfig ? (
          <div className="row text-2">
            <span className="spinner" /> Loading…
          </div>
        ) : (
          <form onSubmit={saveLlmConfig}>
            <div className="field">
              <label>Provider</label>
              <select value={form.provider ?? ""} onChange={(e) => selectProvider(e.target.value)}>
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                    {p === defaultProvider ? " (default)" : ""}
                  </option>
                ))}
                {!isKnownProvider && form.provider && <option value={form.provider}>{form.provider} (custom)</option>}
              </select>
            </div>
            <div className="field">
              <label>Model</label>
              <input value={form.model ?? ""} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} required />
            </div>
            {form.provider !== "anthropic" && (
              <div className="field">
                <label>Base URL</label>
                <input
                  value={form.base_url ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
                  placeholder={providerDefaults[form.provider ?? ""]?.base_url}
                />
                <div className="field-hint">Leave blank to use the known default URL for this provider.</div>
              </div>
            )}
            {requiresKey && (
              <div className="field">
                <label>API key env var</label>
                <input
                  value={form.api_key_env ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, api_key_env: e.target.value }))}
                  placeholder="OPENAI_API_KEY"
                />
                <div className="field-hint">
                  Name of the environment variable holding the key — or set it under "LLM API key" below.
                </div>
              </div>
            )}
            <div className="row" style={{ gap: 10 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Max tokens</label>
                <input
                  type="number"
                  value={form.max_tokens ?? 4096}
                  onChange={(e) => setForm((f) => ({ ...f, max_tokens: parseInt(e.target.value, 10) || 0 }))}
                />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Temperature</label>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  max={2}
                  value={form.temperature ?? 0}
                  onChange={(e) => setForm((f) => ({ ...f, temperature: parseFloat(e.target.value) || 0 }))}
                />
              </div>
            </div>
            {llmError && <div className="badge badge-red" style={{ marginBottom: 12, display: "flex" }}>{llmError}</div>}
            {llmMessage && <div className="badge badge-green" style={{ marginBottom: 12, display: "flex" }}>{llmMessage}</div>}
            <button className="btn btn-primary" disabled={llmBusy}>
              {llmBusy ? <span className="spinner" /> : "Save provider"}
            </button>
          </form>
        )}
      </div>

      <div className="card">
        <div className="card-title">LLM API key</div>
        <p className="text-2" style={{ marginTop: 0, fontSize: 12 }}>
          Overrides the environment-variable key for whichever provider is configured above.
          Never returned once set — only whether one exists. Not needed for Ollama.
        </p>
        <div className="row" style={{ marginBottom: 16 }}>
          {hasKey === null ? (
            <span className="text-2">Checking…</span>
          ) : hasKey ? (
            <>
              <span className="badge badge-green">Key configured</span>
              <button className="btn btn-sm btn-danger" onClick={clearKey}>
                Remove
              </button>
            </>
          ) : (
            <span className="badge badge-amber">No key stored — using environment variable</span>
          )}
        </div>
        <form onSubmit={saveKey}>
          <div className="field">
            <label>Set / replace key</label>
            <input type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="sk-..." />
          </div>
          {message && <div className="badge" style={{ marginBottom: 12 }}>{message}</div>}
          <button className="btn btn-primary" disabled={busy || !keyInput.trim()}>
            {busy ? <span className="spinner" /> : "Save key"}
          </button>
        </form>
      </div>

      <div className="card" style={{ gridColumn: "1 / -1" }}>
        <div className="card-title">Platform status</div>
        {health?.mockLlm && (
          <div className="badge badge-amber" style={{ display: "flex", marginBottom: 14 }}>
            ⚠ Running with a MOCK LLM connection (XCODER_MOCK_LLM) — every task result is
            simulated, not a real model response.
          </div>
        )}
        {health && (
          <div className="grid grid-2" style={{ marginBottom: 16 }}>
            <div className="stat">
              <div className="stat-label">Version</div>
              <div className="stat-value" style={{ fontSize: 18 }}>
                v{health.version}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Uptime</div>
              <div className="stat-value" style={{ fontSize: 18 }}>
                {Math.floor(health.uptime / 60)}m
              </div>
            </div>
          </div>
        )}
        {engines && (
          <>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Registered engines</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {engines.engines.map((e) => (
                <span key={e} className={`badge ${e === engines.default ? "badge-accent" : ""}`}>
                  {e}
                  {e === engines.default ? " · default" : ""}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

