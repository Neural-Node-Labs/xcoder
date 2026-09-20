import { useState, useEffect, useCallback } from "react";
import { api, CodegraphStatus, Project } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { usePageActive, useOnActivate } from "../context/PageActive";

/**
 * Embeds the bundled CodeGraph Explorer (integrations/codegraph/codegraph-ui, served
 * same-origin at /codegraph-ui — see server.ts) in an iframe, pre-authenticated.
 *
 * codegraph-ui reads its API base URL and session token from localStorage keys
 * "codegraph_api_url" / "codegraph_token" / "codegraph_user" (see its src/api.js). Because the
 * iframe is served from the exact same origin as this page, localStorage is shared automatically
 * — writing those keys here, before the iframe mounts, is enough to sign the embedded app in.
 * No cross-frame access or postMessage bridge needed.
 *
 * Two rules this page follows, both learned from it rendering as an empty panel:
 *  1. Every state gets its own explicit message — never a bare spinner or an iframe pointed at
 *     something that isn't there. "Blank" is the one outcome that gives nobody a next step.
 *  2. The "Index this workspace" controls don't depend on the Explorer iframe (or on the user
 *     being an admin). Indexing goes through xcoder's own API, so it works — and reports a clear
 *     error if CodeGraph isn't connected — whether or not the Explorer itself managed to render.
 */
export function CodeGraphExplorerPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  const [status, setStatus] = useState<CodegraphStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    api
      .codegraphStatus()
      .then((s) => {
        setStatus(s);
        setStatusError(null);
      })
      .catch((err) => setStatusError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Keep checking until CodeGraph is up. Under docker-compose, codegraph-api often finishes
  // booting a few seconds AFTER this page is first opened, and the server retries its connection
  // whenever this status endpoint is hit — so polling is what turns "not yet" into "ready"
  // without the user having to reload.
  const running = status?.running ?? false;
  const pageActive = usePageActive();
  useEffect(() => {
    if (running || !pageActive) return;
    const id = setInterval(refreshStatus, 3000);
    return () => clearInterval(id);
  }, [running, pageActive, refreshStatus]);
  useOnActivate(refreshStatus);

  // Once CodeGraph is confirmed running, admins pull an SSO session and sign the embedded iframe
  // in via localStorage before it mounts.
  useEffect(() => {
    if (!status?.running || !status.uiAvailable || !isAdmin) return;
    let cancelled = false;
    setSsoError(null);
    api
      .codegraphSso()
      .then((session) => {
        if (cancelled) return;
        if (!session) {
          setSsoError("CodeGraph reported running but returned no session — try again in a moment.");
          return;
        }
        localStorage.setItem("codegraph_api_url", session.apiUrl);
        localStorage.setItem("codegraph_token", session.token);
        localStorage.setItem("codegraph_user", JSON.stringify(session.user));
        setIframeReady(true);
      })
      .catch((err) => !cancelled && setSsoError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [status?.running, status?.uiAvailable, isAdmin]);

  async function start() {
    setStarting(true);
    setStartError(null);
    try {
      await api.startBundledCodegraph();
      refreshStatus();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const [indexing, setIndexing] = useState(false);
  const [indexResult, setIndexResult] = useState<string | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);

  const refreshProjects = useCallback(() => {
    api
      .projects()
      .then((ps) => {
        setProjects(ps);
        // Always defer to the server's active project when it's known, rather than only filling
        // in a selection the first time — otherwise switching the active project on another page
        // (Workspace, Projects) leaves this page showing whatever was selected here previously,
        // which is the "workspace doesn't match" mismatch this page kept running into.
        setSelectedProjectId((prev) => ps.find((p) => p.active)?.id ?? prev ?? ps[0]?.id);
      })
      .catch(() => {});
  }, []);

  useEffect(refreshProjects, [refreshProjects]);
  // Returning to this page: another page (Workspace, Projects) may have activated a different
  // project while this one sat hidden-but-mounted. Re-sync so the selector — and the workspace
  // "Index this workspace" indexes — reflect the project actually active now.
  useOnActivate(refreshProjects);

  async function indexWorkspace() {
    setIndexing(true);
    setIndexError(null);
    setIndexResult(null);
    try {
      const selected = projects.find((p) => p.id === selectedProjectId);
      const result = await api.indexCodegraphWorkspace(selectedProjectId, selected?.name);
      // Point the embedded Explorer at what was just indexed — it remembers its selected project
      // in this same-origin localStorage key — and reload it so the graph shows up immediately
      // rather than requiring a manual project switch inside the iframe.
      localStorage.setItem("codegraph_project_id", String(result.codegraphProjectId));
      setIframeKey((k) => k + 1);
      setIndexResult(`Indexed "${result.codegraphProjectName}" — ${result.extractedFiles} file(s).`);
    } catch (err) {
      setIndexError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexing(false);
    }
  }

  function notice(body: React.ReactNode) {
    return (
      <div className="card">
        <div className="empty-state">
          <div className="empty-state-icon">◈</div>
          {body}
        </div>
      </div>
    );
  }

  function renderBody() {
    if (!status) {
      if (statusError) {
        return notice(
          <>
            Couldn't reach the xcoder API to check CodeGraph: {statusError}
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-ghost" onClick={refreshStatus}>
                ↺ Retry
              </button>
            </div>
          </>
        );
      }
      return (
        <div className="card">
          <div className="row text-2">
            <span className="spinner" /> Checking CodeGraph status…
          </div>
        </div>
      );
    }

    if (!status.running) {
      // Docker deployment: a sibling codegraph-api service is expected. Explain where we are in
      // connecting to it rather than showing a dead end.
      if (status.configuredUrl) {
        return notice(
          <>
            {status.connectError ? (
              <>
                <div>Couldn't connect to the CodeGraph service at <code className="mono">{status.configuredUrl}</code>.</div>
                <pre className="badge badge-red" style={{ display: "block", marginTop: 12, textAlign: "left", whiteSpace: "pre-wrap" }}>
                  {status.connectError}
                </pre>
                <div className="text-2" style={{ fontSize: 11, marginTop: 8 }}>
                  Check that the <code className="mono">codegraph-api</code> container is running:{" "}
                  <code className="mono">docker compose ps</code> and{" "}
                  <code className="mono">docker compose logs codegraph-api</code>. This page keeps retrying automatically.
                </div>
              </>
            ) : (
              <div className="row" style={{ justifyContent: "center", gap: 8 }}>
                <span className="spinner" /> Connecting to the CodeGraph service at{" "}
                <code className="mono">{status.configuredUrl}</code>…
              </div>
            )}
            {isAdmin && (
              <div style={{ marginTop: 14 }}>
                <button className="btn btn-primary" onClick={start} disabled={starting}>
                  {starting ? <span className="spinner" /> : "↺ Connect now"}
                </button>
                {startError && (
                  <pre className="badge badge-red" style={{ display: "block", marginTop: 12, textAlign: "left", whiteSpace: "pre-wrap" }}>
                    {startError}
                  </pre>
                )}
              </div>
            )}
          </>
        );
      }

      if (!status.bundled) {
        return notice(
          <>
            CodeGraph isn't connected, and this build has no CodeGraph service configured to connect to. Under
            docker-compose, make sure the <code className="mono">codegraph-api</code> service is up (
            <code className="mono">docker compose up -d codegraph-api codegraph-mcp</code>) and that the{" "}
            <code className="mono">api</code> service has <code className="mono">XCODER_CODEGRAPH_URL</code> and{" "}
            <code className="mono">XCODER_CODEGRAPH_ADMIN_PASSWORD</code> set. Otherwise, connect an external instance from
            Platform &gt; Tools.
          </>
        );
      }

      return notice(
        <>
          CodeGraph isn't running yet.
          {isAdmin ? (
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={start} disabled={starting}>
                {starting ? <span className="spinner" /> : "▶ Start bundled CodeGraph"}
              </button>
              {startError && (
                <pre className="badge badge-red" style={{ display: "block", marginTop: 12, textAlign: "left", whiteSpace: "pre-wrap" }}>
                  {startError}
                </pre>
              )}
              {startError?.includes("not found under") && (
                <div className="text-2" style={{ fontSize: 11, marginTop: 8 }}>
                  Run <code className="mono">npm run codegraph:install</code> on the server first — it sets up the Python
                  virtualenv CodeGraph needs.
                </div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 12 }}>Ask an admin to start it from this page or Platform &gt; Tools.</div>
          )}
        </>
      );
    }

    if (!status.uiAvailable) {
      return notice(
        <>
          CodeGraph is connected, but this build doesn't include the Explorer UI bundle, so there's nothing to embed. Indexing
          above and <code className="mono">codegraph_tool</code> still work.
          <div className="text-2" style={{ fontSize: 11, marginTop: 8 }}>
            Local checkout: <code className="mono">npm run codegraph:ui:build</code>, then restart the server. Docker: rebuild
            the <code className="mono">api</code> image (<code className="mono">docker compose build api</code>) — it builds the
            Explorer in.
          </div>
        </>
      );
    }

    if (!isAdmin) {
      return notice(
        <>
          CodeGraph is running at {status.baseUrl}, but the embedded Explorer currently signs in with a shared admin session, so
          only admins can open it here. You can still index your workspace above.
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <code className="mono">codegraph_tool</code> is also available to every engine — try asking the Assistant in Chat to
            search or trace dependencies for you.
          </div>
        </>
      );
    }

    if (ssoError) {
      return notice(
        <>
          Couldn't sign in to CodeGraph: {ssoError}
          <div style={{ marginTop: 14 }}>
            <button className="btn btn-ghost" onClick={refreshStatus}>
              ↺ Retry
            </button>
          </div>
        </>
      );
    }

    if (!iframeReady) {
      return (
        <div className="card">
          <div className="row text-2">
            <span className="spinner" /> Signing in to CodeGraph…
          </div>
        </div>
      );
    }

    return (
      <div className="card" style={{ padding: 0, overflow: "hidden", height: "calc(100vh - 260px)", minHeight: 360 }}>
        <iframe
          key={iframeKey}
          src="/codegraph-ui/"
          title="CodeGraph Explorer"
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
        />
      </div>
    );
  }

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <div className="row" style={{ gap: 8 }}>
          {projects.length > 0 && (
            <select
              value={selectedProjectId ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedProjectId(id);
                // Persist as the server-side "active" project — the same call ProjectsPage and
                // WorkspacePage make — so this page's notion of "current workspace" stays in
                // sync with theirs instead of each page independently defaulting to whatever the
                // server last thought was active.
                api
                  .activateProject(id)
                  .then(() => setProjects((ps) => ps.map((p) => ({ ...p, active: p.id === id }))))
                  .catch(() => {});
              }}
              style={{ width: "auto" }}
              title="xcoder project to index"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.active ? " (active)" : ""}
                </option>
              ))}
            </select>
          )}
          <button className="btn btn-sm btn-primary" onClick={indexWorkspace} disabled={indexing}>
            {indexing ? <span className="spinner" /> : "⟳ Index this workspace"}
          </button>
          {status?.running && status.uiAvailable && isAdmin && (
            <a className="btn btn-sm btn-ghost" href="/codegraph-ui/" target="_blank" rel="noreferrer">
              ↗ Open in new tab
            </a>
          )}
        </div>
        {indexResult && <span className="badge badge-green">{indexResult}</span>}
        {indexError && <span className="badge badge-red">{indexError}</span>}
      </div>
      {renderBody()}
    </div>
  );
}
