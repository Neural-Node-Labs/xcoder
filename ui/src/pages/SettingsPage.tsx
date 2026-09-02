import { useState, useEffect } from "react";
import { api, HealthResponse, EnginesResponse } from "../api/client";

export function SettingsPage() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [engines, setEngines] = useState<EnginesResponse | null>(null);

  useEffect(() => {
    api.llmKeyStatus().then((r) => setHasKey(r.hasKey)).catch(() => setHasKey(false));
    api.health().then(setHealth).catch(() => {});
    api.engines().then(setEngines).catch(() => {});
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

  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <div className="card">
        <div className="card-title">LLM API key</div>
        <p className="text-2" style={{ marginTop: 0, fontSize: 12 }}>
          Overrides the environment-variable key for whichever provider is configured in
          <code className="mono"> agent/config/llm.yaml</code>. Never returned once set — only
          whether one exists.
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

      <div className="card">
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
