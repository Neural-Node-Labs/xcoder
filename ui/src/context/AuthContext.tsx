import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from "react";
import { api, setAuthToken, getAuthToken, setUnauthorizedHandler } from "../api/client";

/**
 * Session lifecycle.
 *
 * The server's token store is in-memory (src/api/auth.ts) and tokens expire after a fixed TTL,
 * so a token restored from localStorage is a *claim* about being signed in, not proof of it. It
 * goes stale whenever the API restarts or the TTL elapses — neither of which the browser is
 * told about.
 *
 * The old behaviour was to trust that claim: render the whole signed-in app immediately and
 * only discover the token was dead when some unrelated request happened to fail. That left the
 * user inside a UI where nothing worked — empty pages, error badges, a dashboard that never
 * loaded — with no indication that the actual problem was an expired session, and no way back
 * to the login screen short of clearing localStorage by hand.
 *
 * Now a restored token is verified before anything signed-in renders, and there are three
 * independent routes back to the login screen, because each catches cases the others miss:
 *
 *   1. Boot check — GET /auth/me before rendering. Catches the API-restarted and
 *      already-expired cases, which are by far the most common.
 *   2. Scheduled expiry — /auth/me returns expiresAt, so the client logs out exactly when the
 *      token dies rather than on the next failed request. Catches a tab left open past the TTL.
 *   3. Reactive 401/403 — the existing handler in client.ts. Catches everything else: an admin
 *      revoking the token, a server restart mid-session, clock skew.
 *
 * Plus a re-check when the tab regains focus, which is when a backgrounded tab is most likely
 * to be holding a session that died while it wasn't looking.
 */

type AuthStatus = "checking" | "authenticated" | "anonymous";

interface AuthState {
  userId: string | null;
  username: string | null;
  role: "admin" | "user" | null;
  token: string | null;
}

interface AuthContextValue extends AuthState {
  /** "checking" while a restored token is being verified — the app must render a neutral
   *  loading state rather than either the login page or the signed-in shell, since showing
   *  the login page to an already-signed-in user is just as wrong as the reverse. */
  status: AuthStatus;
  /** True when the session ended on its own (expired / revoked / server restarted) rather than
   *  by the user clicking "Sign out". Drives the explanatory notice on the login screen — being
   *  bounced to a login form with no explanation reads as a bug. */
  sessionExpired: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  loginWithGoogle: (credential: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadInitial(): AuthState {
  const token = getAuthToken();
  const userId = localStorage.getItem("xcoder_user_id");
  const username = localStorage.getItem("xcoder_username");
  const role = localStorage.getItem("xcoder_role") as "admin" | "user" | null;
  return { token, userId, username, role };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(loadInitial);
  // A token restored from storage starts as unverified; one that isn't there at all needs no
  // verification, so skip straight to "anonymous" and avoid a pointless loading flash.
  const [status, setStatus] = useState<AuthStatus>(() => (getAuthToken() ? "checking" : "anonymous"));
  const [sessionExpired, setSessionExpired] = useState(false);

  const expiryTimer = useRef<number | null>(null);
  // Guards against a stale async /auth/me response clobbering newer state — e.g. the boot check
  // resolving after the user has already signed out, which would otherwise resurrect the
  // session flags for a token that's gone.
  const generation = useRef(0);

  const clearExpiryTimer = () => {
    if (expiryTimer.current !== null) {
      window.clearTimeout(expiryTimer.current);
      expiryTimer.current = null;
    }
  };

  /** Clears local session state only — deliberately no /logout call, so this is safe to invoke
   *  from the "your token is already invalid" paths without re-triggering the same 401/403 and
   *  looping. `expired` distinguishes an involuntary end from a deliberate sign-out. */
  const clearLocalSession = useCallback((expired: boolean) => {
    generation.current += 1;
    clearExpiryTimer();
    setAuthToken(null);
    localStorage.removeItem("xcoder_user_id");
    localStorage.removeItem("xcoder_username");
    localStorage.removeItem("xcoder_role");
    setState({ token: null, userId: null, username: null, role: null });
    setSessionExpired(expired);
    setStatus("anonymous");
  }, []);

  /** Arms a timer to drop the session the moment the token expires. Without this a tab left
   *  open overnight keeps showing a fully-rendered app backed by a dead token until the user
   *  touches something. */
  const scheduleExpiry = useCallback(
    (expiresAt: number) => {
      clearExpiryTimer();
      const msRemaining = expiresAt - Date.now();
      if (msRemaining <= 0) {
        clearLocalSession(true);
        return;
      }
      // setTimeout saturates above ~24.8 days (2^31-1 ms) and would fire immediately. A token
      // that far out just doesn't get a timer; paths 1, 3 and the focus check still cover it.
      if (msRemaining > 2147483647) return;
      expiryTimer.current = window.setTimeout(() => clearLocalSession(true), msRemaining);
    },
    [clearLocalSession]
  );

  const persist = useCallback(
    (token: string, userId: string, username: string, role: "admin" | "user") => {
      generation.current += 1;
      setAuthToken(token);
      localStorage.setItem("xcoder_user_id", userId);
      localStorage.setItem("xcoder_username", username);
      localStorage.setItem("xcoder_role", role);
      setState({ token, userId, username, role });
      setSessionExpired(false);
      setStatus("authenticated");
    },
    []
  );

  /**
   * Verifies the token currently in hand against the server.
   *
   * A rejection here is handled by the unauthorized handler registered below (client.ts calls
   * it on any 401, or a 403 whose message indicates a bad token), so the catch only has to stop
   * the error propagating. Note what it deliberately does NOT do: sign the user out on a
   * network failure. A dropped connection is not an expired session, and logging someone out
   * mid-task because a single probe couldn't reach the server would lose their work for no
   * reason. Only the server actually saying "this token is no good" ends the session.
   */
  const verifySession = useCallback(
    async (opts: { initial: boolean }) => {
      const gen = generation.current;
      try {
        const session = await api.session();
        if (gen !== generation.current) return; // superseded — ignore
        // Trust the server's account details over whatever localStorage had: a role change
        // made by an admin should take effect on reload, not persist from a cached copy.
        localStorage.setItem("xcoder_user_id", session.userId);
        localStorage.setItem("xcoder_username", session.username);
        localStorage.setItem("xcoder_role", session.role);
        setState((prev) => ({
          token: prev.token ?? getAuthToken(),
          userId: session.userId,
          username: session.username,
          role: session.role,
        }));
        setStatus("authenticated");
        scheduleExpiry(session.expiresAt);
      } catch {
        if (gen !== generation.current) return;
        if (opts.initial && getAuthToken()) {
          // Still holding a token after a failed boot check means the failure wasn't an auth
          // rejection (that path already cleared it) — it was the network. Let the user into
          // the app; the reactive handler will catch a genuinely dead token on the first real
          // request, and an offline-but-valid session keeps working.
          setStatus("authenticated");
        }
      }
    },
    [scheduleExpiry]
  );

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await api.login(username, password);
      persist(res.token, res.userId, res.username, res.role);
      void verifySession({ initial: false });
    },
    [persist, verifySession]
  );

  const register = useCallback(
    async (username: string, password: string) => {
      const res = await api.register(username, password);
      persist(res.token, res.userId, res.username, res.role);
      void verifySession({ initial: false });
    },
    [persist, verifySession]
  );

  const loginWithGoogle = useCallback(
    async (credential: string) => {
      const res = await api.loginWithGoogle(credential);
      persist(res.token, res.userId, res.username, res.role);
      void verifySession({ initial: false });
    },
    [persist, verifySession]
  );

  /** Deliberate sign-out: revoke server-side, then clear locally. Not flagged as expired — the
   *  user knows why they're looking at the login screen. */
  const logout = useCallback(() => {
    api.logout().catch(() => {});
    clearLocalSession(false);
  }, [clearLocalSession]);

  // Route 3: any 401 (or bad-token 403) from anywhere in the app ends the session.
  useEffect(() => {
    setUnauthorizedHandler(() => clearLocalSession(true));
    return () => setUnauthorizedHandler(null);
  }, [clearLocalSession]);

  // Route 1: verify a restored token before rendering anything signed-in. Runs once on mount.
  useEffect(() => {
    if (getAuthToken()) void verifySession({ initial: true });
     
  }, []);

  // Re-check when the tab comes back to the foreground — a backgrounded tab is exactly where a
  // session is most likely to have died unnoticed, and its timers are throttled besides.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && getAuthToken()) {
        void verifySession({ initial: false });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [verifySession]);

  useEffect(() => clearExpiryTimer, []);

  return (
    <AuthContext.Provider
      value={{ ...state, status, sessionExpired, login, register, loginWithGoogle, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
