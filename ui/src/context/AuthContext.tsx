import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react";
import { api, setAuthToken, getAuthToken, setUnauthorizedHandler } from "../api/client";

interface AuthState {
  userId: string | null;
  username: string | null;
  role: "admin" | "user" | null;
  token: string | null;
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
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

  const persist = (token: string, userId: string, username: string, role: "admin" | "user") => {
    setAuthToken(token);
    localStorage.setItem("xcoder_user_id", userId);
    localStorage.setItem("xcoder_username", username);
    localStorage.setItem("xcoder_role", role);
    setState({ token, userId, username, role });
  };

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    persist(res.token, res.userId, res.username, res.role);
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const res = await api.register(username, password);
    persist(res.token, res.userId, res.username, res.role);
  }, []);

  const logout = useCallback(() => {
    api.logout().catch(() => {});
    clearLocalSession();
  }, []);

  // Clears local session state only — no /logout call — so this is safe to invoke from the
  // "your token is already invalid" path without re-triggering the same 401/403 in a loop.
  const clearLocalSession = () => {
    setAuthToken(null);
    localStorage.removeItem("xcoder_user_id");
    localStorage.removeItem("xcoder_username");
    localStorage.removeItem("xcoder_role");
    setState({ token: null, userId: null, username: null, role: null });
  };

  useEffect(() => {
    setUnauthorizedHandler(clearLocalSession);
    return () => setUnauthorizedHandler(null);
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
