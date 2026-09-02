import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { api, setAuthToken, getAuthToken } from "../api/client";

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
  const userId = localStorage.getItem("devnull_user_id");
  const username = localStorage.getItem("devnull_username");
  const role = localStorage.getItem("devnull_role") as "admin" | "user" | null;
  return { token, userId, username, role };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(loadInitial);

  const persist = (token: string, userId: string, username: string, role: "admin" | "user") => {
    setAuthToken(token);
    localStorage.setItem("devnull_user_id", userId);
    localStorage.setItem("devnull_username", username);
    localStorage.setItem("devnull_role", role);
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
    setAuthToken(null);
    localStorage.removeItem("devnull_user_id");
    localStorage.removeItem("devnull_username");
    localStorage.removeItem("devnull_role");
    setState({ token: null, userId: null, username: null, role: null });
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
