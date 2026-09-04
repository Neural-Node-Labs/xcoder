import { useState, useEffect } from "react";
import { api, PlatformToolEntry, PlatformIntegrationEntry, CodegraphStatus } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { Page } from "../components/Sidebar";

export function PlatformToolsPage({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  const [tools, setTools] = useState<PlatformToolEntry[]>([]);
  const [toolFilter, setToolFilter] = useState("");
  const [loadingTools, setLoadingTools] = useState(true);

  const [integrations, setIntegrations] = useState<PlatformIntegrationEntry[]>([]);
  const [cgStatus, setCgStatus] = useState<CodegraphStatus | null>(null);
  const [loadingIntegrations, setLoadingIntegrations] = useState(true);

  const [showManualForm, setShowManualForm] = useState(false);
  const [baseUrl, setBaseUrl] = useState("http://localhost:8000");
  const [apiKey, setApiKey] = useState("");
  const [defaultProjectId, setDefaultProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refreshTools() {
    api.platformTools().then((r) => setTools(r.tools)).finally(() => setLoadingTools(false));
  }
  function refreshIntegrations() {
    Promise.all([api.platformIntegrations(), api.codegraphStatus()])
      .then(([i, s]) => {
        setIntegrations(i.integrations);
        setCgStatus(s);
      })
      .finally(() => setLoadingIntegrations(false));
  }

  useEffect(() => {
    refreshTools();
    refreshIntegrations();
  }, []);

  const codegraph = integrations.find((i) => i.id === "codegraph");
  const bundledRunning = cgStatus?.running ?? false;

  const filteredTools = tools.filter(
    (t) => !toolFilter || t.name.toLowerCase().includes(toolFilter.toLowerCase()) || t.description.toLowerCase().includes(toolFilter.toLowerCase())
  );

  async function startBundled() {
    setBusy(true);
    setError(null);
    try {
      await api.startBundledCodegraph();
      refreshIntegrations();
      refreshTools();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stopBundled() {
    if (!confirm("Stop the bundled CodeGraph server? codegraph_tool and the Explorer will be unavailable until it's started again.")) return;
    setBusy(true);
    try {
      await api.stopBundledCodegraph();
      refreshIntegrations();
      refreshTools();
    } finally {
      setBusy(false);
    }
  }

  async function connectManual(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.connectCodegraph(baseUrl.trim(), apiKey.trim(), defaultProjectId.trim() || undefined);
      setApiKey("");
      setShowManualForm(false);
      refreshIntegrations();
      refreshTools();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect CodeGraph? codegraph_tool will stop being available to the orchestrator.")) return;
    setBusy(true);
    try {
      await api.disconnectCodegraph();
      refreshIntegrations();
      refreshTools();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <div className="card">
        <div className="row-between" style={{ marginBottom: 12 }}>
          <div className="card-title" style={{ margin: 0 }}>
            Tools
          </div>
          <span className="text-2" style={{ fontSize: 11 }}>{tools.length} available</span>
        </div>
        <input
          style={{ width: "100%", marginBottom: 12 }}
          placeholder="Filter tools…"
          value={toolFilter}
          onChange={(e) => setToolFilter(e.target.value)}
        />

        {loadingTools && (
          <div className="row text-2">
            <span className="spinner" /> Loading…
          </div>
        )}

        {!loadingTools && filteredTools.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            No tools match "{toolFilter}".
          </div>
        )}

        {/* Shows at most ~5 rows before scrolling — see .tool-list in styles.css */}
        <div className="tool-list">
          {filteredTools.map((t) => (
            <div className="tool-row" key={t.name}>
              <div style={{ minWidth: 0 }}>
                <div className="tool-row-name">{t.name}</div>
                <div className="tool-row-desc">{t.description}</div>
              </div>
              {t.source === "integration" && <span className="badge badge-blue" style={{ flexShrink: 0 }}>integration</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Integrations</div>

        {loadingIntegrations && (
          <div className="row text-2">
            <span className="spinner" /> Loading…
          </div>
        )}

        {codegraph && cgStatus && (
          <>
            <div className="integration-card">
              <div className="row" style={{ gap: 12, minWidth: 0 }}>
                <div className="integration-card-icon">◈</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{codegraph.name}</div>
                  <div className="text-2" style={{ fontSize: 11 }}>
                    {cgStatus.bundled
                      ? "Ships with xcoder — API, MCP server, and Explorer UI all bundled. No separate deployment needed."
                      : codegraph.description}
                  </div>
                </div>
              </div>
              <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
                {codegraph.connected ? <span className="badge badge-green">Connected</span> : <span className="badge">Not connected</span>}
              </div>
            </div>

            {cgStatus.bundled && (
              <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                {bundledRunning ? (
                  <>
                    <span className="badge badge-green">Bundled server running on :{cgStatus.port}</span>
                    <button className="btn btn-sm btn-primary" onClick={() => onNavigate("codegraph")}>
                      Open Explorer
                    </button>
                    {isAdmin && (
                      <button className="btn btn-sm btn-danger" onClick={stopBundled} disabled={busy}>
                        Stop
                      </button>
                    )}
                  </>
                ) : isAdmin ? (
                  <button className="btn btn-sm btn-primary" onClick={startBundled} disabled={busy}>
                    {busy ? <span className="spinner" /> : "▶ Start bundled CodeGraph"}
                  </button>
                ) : (
                  <span className="text-2" style={{ fontSize: 11 }}>Ask an admin to start CodeGraph.</span>
                )}
              </div>
            )}

            {!bundledRunning && codegraph.connected && isAdmin && (
              <button className="btn btn-sm btn-danger" style={{ marginBottom: 14 }} onClick={disconnect} disabled={busy}>
                Disconnect
              </button>
            )}

            {isAdmin && (
              <div style={{ marginBottom: 4 }}>
                <button className="btn btn-sm btn-ghost" onClick={() => setShowManualForm((v) => !v)}>
                  {showManualForm ? "Hide" : "Advanced: connect an external instance instead"}
                </button>
              </div>
            )}
          </>
        )}

        {showManualForm && (
          <form onSubmit={connectManual} style={{ marginTop: 8 }}>
            <div className="field">
              <label>CodeGraph API URL</label>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:8000" required />
            </div>
            <div className="field">
              <label>API key</label>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="From CodeGraph's Users admin screen" required />
            </div>
            <div className="field">
              <label>Default project ID (optional)</label>
              <input value={defaultProjectId} onChange={(e) => setDefaultProjectId(e.target.value)} placeholder="e.g. 1" />
              <div className="field-hint">Used when a tool call doesn't specify a project explicitly.</div>
            </div>
            {error && <div className="badge badge-red" style={{ marginBottom: 12 }}>{error}</div>}
            <button className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" /> : "Connect"}
            </button>
          </form>
        )}

        {error && !showManualForm && <div className="badge badge-red" style={{ marginTop: 10 }}>{error}</div>}

        <div className="text-2" style={{ fontSize: 11, marginTop: 14 }}>
          Once connected, <code className="mono">codegraph_tool</code> becomes available to every engine (including{" "}
          <code className="mono">assistant</code> in the Chat tab) for structural code search, dependency/impact analysis, and symbol path-finding.
          The bundled MCP server is also reachable from <code className="mono">mcp_tool</code> via command <code className="mono">codegraph-mcp</code>.
        </div>
      </div>
    </div>
  );
}
