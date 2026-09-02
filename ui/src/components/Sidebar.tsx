import { useAuth } from "../context/AuthContext";

export type Page = "dashboard" | "wbs" | "history" | "skills" | "projects" | "logs" | "users" | "settings";

const NAV: { section: string; items: { key: Page; label: string; icon: string; adminOnly?: boolean }[] }[] = [
  {
    section: "Orchestration",
    items: [
      { key: "dashboard", label: "Run a task", icon: "▶" },
      { key: "wbs", label: "DAG / WBS board", icon: "⛓" },
      { key: "history", label: "Task history", icon: "🕘" },
      { key: "logs", label: "Live logs", icon: "▤" },
    ],
  },
  {
    section: "Platform",
    items: [
      { key: "skills", label: "Skills", icon: "◈" },
      { key: "projects", label: "Projects", icon: "▢" },
    ],
  },
  {
    section: "Admin",
    items: [
      { key: "users", label: "Users", icon: "◍", adminOnly: true },
      { key: "settings", label: "Settings", icon: "⚙" },
    ],
  },
];

export function Sidebar({ page, onNavigate }: { page: Page; onNavigate: (p: Page) => void }) {
  const { username, role, logout } = useAuth();

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">⌗</div>
        <div>
          <div className="brand-text">xcoder</div>
          <div className="brand-sub">SDLC Platform</div>
        </div>
      </div>

      {NAV.map((group) => (
        <div className="nav-group" key={group.section}>
          <div className="nav-label">{group.section}</div>
          {group.items
            .filter((item) => !item.adminOnly || role === "admin")
            .map((item) => (
              <button
                key={item.key}
                className={`nav-item ${page === item.key ? "active" : ""}`}
                onClick={() => onNavigate(item.key)}
              >
                <span className="nav-icon">{item.icon}</span>
                {item.label}
              </button>
            ))}
        </div>
      ))}

      <div className="sidebar-footer">
        <div className="row-between" style={{ padding: "6px 10px" }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{username}</div>
            <div style={{ fontSize: 10, color: "var(--text-2)", textTransform: "uppercase" }}>{role}</div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={logout} title="Sign out">
            ⏻
          </button>
        </div>
      </div>
    </aside>
  );
}
