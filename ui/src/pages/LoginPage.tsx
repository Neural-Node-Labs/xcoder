import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";

export function LoginPage() {
  const { login, register } = useAuth();
  const [needsRegistration, setNeedsRegistration] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .userCount()
      .then((r) => setNeedsRegistration(r.count === 0))
      .catch(() => setNeedsRegistration(false));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (needsRegistration) await register(username.trim(), password);
      else await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="row" style={{ marginBottom: 20 }}>
          <div className="brand-mark">⌗</div>
          <div>
            <div className="brand-text">xcoder</div>
            <div className="brand-sub">SDLC Orchestration Platform</div>
          </div>
        </div>

        {needsRegistration === null ? (
          <div className="text-2">Checking setup status…</div>
        ) : (
          <form onSubmit={submit}>
            <p className="text-2" style={{ marginTop: 0, marginBottom: 18, fontSize: 12 }}>
              {needsRegistration
                ? "No accounts exist yet — create the first (admin) account to get started."
                : "Sign in to continue."}
            </p>
            <div className="field">
              <label>Username</label>
              <input
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. ada"
                required
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={needsRegistration ? 4 : undefined}
              />
            </div>
            {error && (
              <div className="badge badge-red" style={{ marginBottom: 14, display: "flex" }}>
                {error}
              </div>
            )}
            <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
              {busy ? <span className="spinner" /> : needsRegistration ? "Create admin account" : "Sign in"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
