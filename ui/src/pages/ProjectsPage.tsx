import { useState, useEffect } from "react";
import { usePageActive, useOnActivate } from "../context/PageActive";
import { api, Project } from "../api/client";
import { useAuth } from "../context/AuthContext";
import type { Page } from "../components/Sidebar";

export function ProjectsPage({ onNavigate }: { onNavigate?: (page: Page) => void }) {
  const { role, userId } = useAuth();
  const isAdmin = role === "admin";
  const [showAll, setShowAll] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [indexing, setIndexing] = useState<string | null>(null);
  const [indexResult, setIndexResult] = useState<Record<string, { ok: boolean; message: string }>>({});

  function refresh() {
    api.projects(isAdmin && showAll).then(setProjects).catch(() => {});
  }

  useEffect(refresh, [showAll]);
  useOnActivate(refresh); // e.g. a project added/activated elsewhere while this page was hidden

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

  async function indexForCodegraph(project: Project) {
    setIndexing(project.id);
    setIndexResult((r) => ({ ...r, [project.id]: undefined as never }));
    try {
      const result = await api.indexCodegraphWorkspace(project.id, project.name);
      setIndexResult((r) => ({
        ...r,
        [project.id]: { ok: true, message: `Indexed ${result.extractedFiles} files into CodeGraph project "${result.codegraphProjectName}".` },
      }));
    } catch (err) {
      setIndexResult((r) => ({ ...r, [project.id]: { ok: false, message: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setIndexing(null);
    }
  }

  async function openInWorkspace(id: string) {
    await api.activateProject(id);
    refresh();
    onNavigate?.("workspace");
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
          <div key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="row-between" style={{ padding: "10px 0" }}>
              <button
                className="btn btn-ghost btn-sm"
                style={{ padding: 0, justifyContent: "flex-start" }}
                onClick={() => setExpanded(expanded === p.id ? null : p.id)}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {expanded === p.id ? "▾ " : "▸ "}
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
              </button>
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

            {expanded === p.id && (
              <div style={{ padding: "0 0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="grid grid-2" style={{ fontSize: 12 }}>
                  <div>
                    <div className="text-2">Project ID</div>
                    <div className="mono">{p.id}</div>
                  </div>
                  <div>
                    <div className="text-2">Created</div>
                    <div>{new Date(p.createdAt).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-2">Included when running tasks</div>
                    <div>{p.includeInLlm ? "Yes" : "No"}</div>
                  </div>
                  <div>
                    <div className="text-2">Full path</div>
                    <div className="mono" style={{ wordBreak: "break-all" }}>{p.path}</div>
                  </div>
                </div>

                <div className="row" style={{ gap: 8 }}>
                  <button className="btn btn-sm" onClick={() => openInWorkspace(p.id)}>
                    Open in Workspace
                  </button>
                  <button className="btn btn-sm" onClick={() => indexForCodegraph(p)} disabled={indexing === p.id}>
                    {indexing === p.id ? <span className="spinner" /> : "Index for CodeGraph"}
                  </button>
                </div>

                {indexResult[p.id] && (
                  <div className={`badge ${indexResult[p.id].ok ? "badge-green" : "badge-red"}`} style={{ display: "flex" }}>
                    {indexResult[p.id].message}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
