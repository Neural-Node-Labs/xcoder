import { useState, useEffect } from "react";
import { api, User } from "../api/client";

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [accountType, setAccountType] = useState<"local" | "google">("local");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    api.users().then(setUsers).catch(() => {});
  }

  useEffect(refresh, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (accountType === "google") {
        await api.createGoogleUser(email.trim(), role);
        setEmail("");
      } else {
        await api.createUser(username.trim(), password, role);
        setUsername("");
        setPassword("");
      }
      setRole("user");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this user?")) return;
    await api.deleteUser(id);
    refresh();
  }

  async function toggleRole(u: User) {
    await api.updateUser(u.id, { role: u.role === "admin" ? "user" : "admin" });
    refresh();
  }

  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <div className="card">
        <div className="card-title">Add a user</div>

        <div className="field">
          <label>Account type</label>
          <select value={accountType} onChange={(e) => setAccountType(e.target.value as "local" | "google")}>
            <option value="local">Username &amp; password</option>
            <option value="google">Google account</option>
          </select>
          <div className="field-hint">
            {accountType === "google"
              ? "No password is set here — this person signs in themselves with the \"Sign in with Google\" button on the login screen, using this email."
              : "A local account authenticated with a username and password you set."}
          </div>
        </div>

        <form onSubmit={create}>
          {accountType === "google" ? (
            <div className="field">
              <label>Google email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                required
              />
            </div>
          ) : (
            <>
              <div className="field">
                <label>Username</label>
                <input value={username} onChange={(e) => setUsername(e.target.value)} required />
              </div>
              <div className="field">
                <label>Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={4} required />
              </div>
            </>
          )}
          <div className="field">
            <label>Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "user")}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          {error && <div className="badge badge-red" style={{ marginBottom: 12 }}>{error}</div>}
          <button className="btn btn-primary" disabled={busy}>
            {busy ? <span className="spinner" /> : accountType === "google" ? "Add Google account" : "Add user"}
          </button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Users</div>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Sign-in</th>
              <th>Role</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td style={{ fontWeight: 600 }}>
                  {u.username}
                  {u.email && <div className="text-2" style={{ fontWeight: 400, fontSize: 11 }}>{u.email}</div>}
                </td>
                <td>
                  <span className={`badge ${u.authProvider === "google" ? "badge-blue" : ""}`}>
                    {u.authProvider === "google" ? "Google" : "Local"}
                  </span>
                </td>
                <td>
                  <span className={`badge ${u.role === "admin" ? "badge-accent" : ""}`}>{u.role}</span>
                </td>
                <td className="text-2">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td>
                  <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                    <button className="btn btn-sm" onClick={() => toggleRole(u)}>
                      Make {u.role === "admin" ? "user" : "admin"}
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => remove(u.id)}>
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
