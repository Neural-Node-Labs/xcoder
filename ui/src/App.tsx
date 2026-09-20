import { useState, useEffect, type ReactNode } from "react";
import { PageActiveProvider } from "./context/PageActive";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { Sidebar, Page } from "./components/Sidebar";
import { ThemeControls } from "./components/ThemeControls";
import { Dashboard } from "./pages/Dashboard";
import { WbsBoard } from "./pages/WbsBoard";
import { TaskHistoryPage } from "./pages/TaskHistoryPage";
import { SkillsPage } from "./pages/SkillsPage";
import { LogsPage } from "./pages/LogsPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { PlatformToolsPage } from "./pages/PlatformToolsPage";
import { CodeGraphExplorerPage } from "./pages/CodeGraphExplorerPage";
import { SecurityOpsPage } from "./pages/SecurityOpsPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { UsersPage } from "./pages/UsersPage";
import { SettingsPage } from "./pages/SettingsPage";

const TITLES: Record<Page, { title: string; sub: string }> = {
  dashboard: { title: "Run a task", sub: "Submit work to the SDLC orchestration pipeline, or chat directly with the Assistant engine" },
  wbs: { title: "DAG / WBS board", sub: "Track stage-by-stage progress and phase reports" },
  history: { title: "Task history", sub: "Completed top-level runs" },
  skills: { title: "Skills", sub: "Hot-pluggable role skills available to every engine" },
  projects: { title: "Projects", sub: "Workspaces xcoder can run tasks against" },
  workspace: { title: "Workspace", sub: "Browse, create, edit, and delete files in a project" },
  tools: { title: "Tools", sub: "Every tool the orchestrator can call, plus connected integrations" },
  codegraph: { title: "CodeGraph Explorer", sub: "Bundled with xcoder — browse the graph, search, and manage projects" },
  secops: { title: "Security Ops", sub: "Blue/Red Team checks, available to every engine as security_ops_tool" },
  logs: { title: "Live logs", sub: "Thought / action / observation, as it happens" },
  users: { title: "Users", sub: "Manage platform accounts" },
  auditlog: { title: "Audit log", sub: "Who did what — every admin-only action, with a timestamp" },
  settings: { title: "Settings", sub: "LLM key and platform status" },
};

const PAGE_STORAGE_KEY = "xcoder_page";

const ADMIN_ONLY_PAGES: Page[] = ["users", "auditlog"];

function readStoredPage(role: "admin" | "user" | null): Page {
  try {
    const saved = sessionStorage.getItem(PAGE_STORAGE_KEY);
    // Don't restore an admin-only page for a non-admin (e.g. a different account signed in on
    // this tab since) — the sidebar wouldn't even list it.
    if (saved && saved in TITLES && (role === "admin" || !ADMIN_ONLY_PAGES.includes(saved as Page))) return saved as Page;
  } catch {
    // sessionStorage can be unavailable (privacy modes) — fall back to the default page.
  }
  return "dashboard";
}

function Shell() {
  const { role } = useAuth();
  const [page, setPage] = useState<Page>(() => readStoredPage(role));
  // Pages are mounted the first time they're visited and then kept mounted (hidden) so their
  // state survives navigation. Previously each page was rendered as `page === "x" && <X />`,
  // which unmounts it on navigation and throws away everything in it — the task you were
  // typing, the chat transcript, a run still in flight, the file open in the workspace.
  const [visited, setVisited] = useState<Set<Page>>(() => new Set([page]));
  const meta = TITLES[page];

  function navigate(next: Page) {
    setPage(next);
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
  }

  useEffect(() => {
    try {
      sessionStorage.setItem(PAGE_STORAGE_KEY, page);
    } catch {
      /* non-fatal */
    }
  }, [page]);

  // `display: contents` while active keeps the wrapper layout-transparent, so each page lays out
  // exactly as it did when it was a direct child of .content.
  function keepAlive(key: Page, node: ReactNode) {
    if (!visited.has(key)) return null;
    const active = page === key;
    return (
      <div key={key} style={{ display: active ? "contents" : "none" }}>
        <PageActiveProvider value={active}>{node}</PageActiveProvider>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} onNavigate={navigate} />
      <div className="main">
        <div className="topbar">
          <div>
            <div className="page-title">{meta.title}</div>
            <div className="page-subtitle">{meta.sub}</div>
          </div>
        </div>
        <div className="content">
          {keepAlive("dashboard", <Dashboard />)}
          {keepAlive("wbs", <WbsBoard />)}
          {keepAlive("history", <TaskHistoryPage />)}
          {keepAlive("skills", <SkillsPage />)}
          {keepAlive("logs", <LogsPage />)}
          {keepAlive("projects", <ProjectsPage onNavigate={navigate} />)}
          {keepAlive("workspace", <WorkspacePage />)}
          {keepAlive("tools", <PlatformToolsPage onNavigate={navigate} />)}
          {keepAlive("codegraph", <CodeGraphExplorerPage />)}
          {keepAlive("secops", <SecurityOpsPage />)}
          {keepAlive("users", <UsersPage />)}
          {keepAlive("auditlog", <AuditLogPage />)}
          {keepAlive("settings", <SettingsPage />)}
        </div>
      </div>
    </div>
  );
}

function Gate() {
  const { token, status } = useAuth();

  // A restored token hasn't been verified yet. Rendering the signed-in shell here is what the
  // old code did, and it's how users ended up inside a dead app: every page firing requests
  // against an expired token, failing, and showing nothing. Rendering the login page instead
  // would be just as wrong — it would flash a login form at users whose session is perfectly
  // fine. So render neither until the server has answered.
  if (status === "checking") {
    return (
      <div className="session-check">
        <span className="spinner" />
        <span>Restoring your session…</span>
      </div>
    );
  }

  return (
    <>
      {token && status === "authenticated" ? <Shell /> : <LoginPage />}
      <ThemeControls />
    </>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
