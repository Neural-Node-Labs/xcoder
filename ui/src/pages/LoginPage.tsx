import { useState, useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { api } from "../api/client";
import { XcoderLogo } from "../components/XcoderLogo";

// Minimal shape of the pieces of Google Identity Services (GIS) this page uses. GIS attaches
// itself to `window.google` once its script tag has loaded — there's no npm package for it,
// it's a script Google hosts and versions independently, so we declare just what we call.
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const GSI_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  const existing = document.querySelector(`script[src="${GSI_SCRIPT_SRC}"]`);
  if (existing) {
    return new Promise((resolve) => existing.addEventListener("load", () => resolve()));
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GSI_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Sign-In"));
    document.head.appendChild(script);
  });
}

export function LoginPage() {
  const { login, register, loginWithGoogle, sessionExpired } = useAuth();
  const [needsRegistration, setNeedsRegistration] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .userCount()
      .then((r) => setNeedsRegistration(r.count === 0))
      .catch(() => setNeedsRegistration(false));
  }, []);

  // Set up "Sign in with Google": fetch the public client id from the server (no-op if the
  // deployment hasn't configured XCODER_GOOGLE_CLIENT_ID), load Google's GIS script, then
  // render its button into googleButtonRef. GIS calls back with a signed ID token, which we
  // hand straight to AuthContext.loginWithGoogle — the server does the real verification.
  useEffect(() => {
    let cancelled = false;
    api
      .googleSignInConfig()
      .then(async (cfg) => {
        if (cancelled || !cfg.enabled || !googleButtonRef.current) return;
        await loadGoogleScript();
        if (cancelled || !window.google || !googleButtonRef.current) return;
        window.google.accounts.id.initialize({
          client_id: cfg.clientId,
          callback: async (response) => {
            setError(null);
            setBusy(true);
            try {
              await loginWithGoogle(response.credential);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          },
        });
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          theme: "filled_black",
          size: "large",
          width: 280,
          text: needsRegistration ? "signup_with" : "signin_with",
        });
        setGoogleEnabled(true);
      })
      .catch(() => setGoogleEnabled(false));
    return () => {
      cancelled = true;
    };
  }, [needsRegistration, loginWithGoogle]);

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
          <div className="brand-mark">
            <XcoderLogo size={30} />
          </div>
          <div>
            <div className="brand-text">xcoder</div>
            <div className="brand-sub">SDLC Orchestration Platform</div>
          </div>
        </div>

        {/* Being bounced to a login form with no explanation reads as a bug rather than as a
            security feature, so say plainly why the session ended. Shown above the setup-status
            branch so it appears even while the user-count probe is still in flight. */}
        {sessionExpired && (
          <div className="badge badge-amber session-expired-notice">
            Your session ended and you've been signed out. This happens when a session expires or
            the server restarts. Please sign in again.
          </div>
        )}

        {needsRegistration === null ? (
          <div className="text-2">Checking setup status…</div>
        ) : (
          <>
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

            {/* Hidden (0-height) until GIS actually finishes loading + rendering into it, so no
                empty gap or "or" divider shows on deployments that haven't configured Google
                sign-in at all (XCODER_GOOGLE_CLIENT_ID unset). */}
            <div style={{ marginTop: googleEnabled ? 18 : 0, height: googleEnabled ? "auto" : 0, overflow: "hidden" }}>
              <div className="divider" />
              <div style={{ textAlign: "center", fontSize: 11, color: "var(--text-2)", margin: "10px 0" }}>
                or continue with
              </div>
              <div style={{ display: "flex", justifyContent: "center" }} ref={googleButtonRef} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
