import { useState, useEffect } from "react";
import { api, Project } from "../api/client";
import { useAuth } from "../context/AuthContext";

export function ProjectsPage() {
  const { role, userId } = useAuth();
  const isAdmin = role === "admin";
  const [showAll, setShowAll] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    api.projects(isAdmin && showAll).then(setProjects).catch(() => {});
  }

  useEffect(refresh, [showAll]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createProject(name.trim());
      setName("");
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function activate(id: string) {
    await api.activateProject(id);
    refresh();
  }

  async function remove(id: string) {
    if (!confirm("Remove this project? Its workspace files are left on disk untouched.")) return;
    await api.deleteProject(id);
    refresh();
  }

  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <div className="card">
        <div className="card-title">Add a project</div>
        <p className="text-2" style={{ marginTop: 0, marginBottom: 16, fontSize: 12 }}>
          Give it a name — xcoder creates and manages the workspace folder for you, under your
          own private workspace root. Projects are fully isolated per user: another user can use
          the exact same project name with no conflict, and can never see, edit, or run tasks
          against yours.
        </p>
        <form onSubmit={create}>
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. payments-service" required />
          </div>
          {error && (
            <div className="badge badge-red" style={{ marginBottom: 12, display: "flex" }}>
              {error}
            </div>
          )}
          <button className="btn btn-primary" disabled={busy}>
            {busy ? <span className="spinner" /> : "Add project"}
          </button>
        </form>
      </div>

      <div className="card">
        <div className="row-between" style={{ marginBottom: 14 }}>
          <div className="card-title" style={{ margin: 0 }}>
            {showAll ? "All users' projects" : "Your projects"}
          </div>
          {isAdmin && (
            <label className="row" style={{ gap: 6, fontWeight: 400, fontSize: 12 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              View all users (admin)
            </label>
          )}
        </div>

        {projects.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">▢</div>
            No projects yet — the server falls back to its own working directory until you add one.
          </div>
        )}

        {projects.map((p) => (
          <div key={p.id} className="row-between" style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {p.name}
                {p.active && <span className="badge badge-accent" style={{ marginLeft: 6 }}>active</span>}
                {showAll && (
                  <span className="badge" style={{ marginLeft: 6 }}>
                    {p.userId === userId ? "you" : `user ${p.userId.slice(0, 8)}`}
                  </span>
                )}
              </div>
              <div className="text-2 mono" style={{ fontSize: 11 }}>
                {p.path}
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              {!p.active && (
                <button className="btn btn-sm" onClick={() => activate(p.id)}>
                  Activate
                </button>
              )}
              <button className="btn btn-sm btn-danger" onClick={() => remove(p.id)}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
