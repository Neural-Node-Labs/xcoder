import { useState, useEffect, useCallback } from "react";
import { api, CodegraphStatus } from "../api/client";
import { useAuth } from "../context/AuthContext";

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
 * This page is reachable directly from the sidebar (Platform > CodeGraph) rather than only via
 * a button buried on the Tools page, so it needs to handle every state on its own: not
 * installed, installed but stopped, starting, running-but-you're-not-an-admin (only admins get
 * an SSO session today), and running-and-ready.
 */
export function CodeGraphExplorerPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  const [status, setStatus] = useState<CodegraphStatus | null>(null);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    api.codegraphStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Once the bundled server is confirmed running, admins pull an SSO session and sign the
  // embedded iframe in via localStorage before it mounts.
  useEffect(() => {
    if (!status?.running || !isAdmin) return;
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
  }, [status?.running, isAdmin]);

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

  if (!status) {
    return (
      <div className="card">
        <div className="row text-2">
          <span className="spinner" /> Checking CodeGraph status…
        </div>
      </div>
    );
  }

  if (!status.bundled) {
    return (
      <div className="card">
        <div className="empty-state">
          <div className="empty-state-icon">◈</div>
          This build wasn't packaged with the bundled CodeGraph source (integrations/codegraph/).
          Connect an external instance instead from Platform &gt; Tools.
        </div>
      </div>
    );
  }

  if (!status.running) {
    return (
      <div className="card">
        <div className="empty-state">
          <div className="empty-state-icon">◈</div>
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
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="card">
        <div className="empty-state">
          <div className="empty-state-icon">◈</div>
          CodeGraph is running on :{status.port}, but the embedded Explorer currently signs in
          with a shared admin session, so only admins can open it here.
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <code className="mono">codegraph_tool</code> is still available to every engine — try asking the Assistant in
            Chat to search or trace dependencies for you.
          </div>
        </div>
      </div>
    );
  }

  if (ssoError) {
    return (
      <div className="card">
        <div className="empty-state">
          <div className="empty-state-icon">◈</div>
          Couldn't sign in to CodeGraph: {ssoError}
          <div style={{ marginTop: 14 }}>
            <button className="btn btn-ghost" onClick={refreshStatus}>
              ↺ Retry
            </button>
          </div>
        </div>
      </div>
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
    <div className="card" style={{ padding: 0, overflow: "hidden", height: "calc(100vh - 180px)" }}>
      <iframe
        src="/codegraph-ui/"
        title="CodeGraph Explorer"
        style={{ width: "100%", height: "100%", border: "none", display: "block" }}
      />
    </div>
  );
}
