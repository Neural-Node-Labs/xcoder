import { useState } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { Sidebar, Page } from "./components/Sidebar";
import { Dashboard } from "./pages/Dashboard";
import { WbsBoard } from "./pages/WbsBoard";
import { TaskHistoryPage } from "./pages/TaskHistoryPage";
import { SkillsPage } from "./pages/SkillsPage";
import { LogsPage } from "./pages/LogsPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { UsersPage } from "./pages/UsersPage";
import { SettingsPage } from "./pages/SettingsPage";

const TITLES: Record<Page, { title: string; sub: string }> = {
  dashboard: { title: "Run a task", sub: "Submit work to the SDLC orchestration pipeline" },
  wbs: { title: "DAG / WBS board", sub: "Track stage-by-stage progress and phase reports" },
  history: { title: "Task history", sub: "Completed top-level runs" },
  skills: { title: "Skills", sub: "Hot-pluggable role skills available to every engine" },
  projects: { title: "Projects", sub: "Workspaces devnull can run tasks against" },
  logs: { title: "Live logs", sub: "Thought / action / observation, as it happens" },
  users: { title: "Users", sub: "Manage platform accounts" },
  settings: { title: "Settings", sub: "LLM key and platform status" },
};

function Shell() {
  const [page, setPage] = useState<Page>("dashboard");
  const meta = TITLES[page];

  return (
    <div className="app-shell">
      <Sidebar page={page} onNavigate={setPage} />
      <div className="main">
        <div className="topbar">
          <div>
            <div className="page-title">{meta.title}</div>
            <div className="page-subtitle">{meta.sub}</div>
          </div>
        </div>
        <div className="content">
          {page === "dashboard" && <Dashboard />}
          {page === "wbs" && <WbsBoard />}
          {page === "history" && <TaskHistoryPage />}
          {page === "skills" && <SkillsPage />}
          {page === "logs" && <LogsPage />}
          {page === "projects" && <ProjectsPage />}
          {page === "users" && <UsersPage />}
          {page === "settings" && <SettingsPage />}
        </div>
      </div>
    </div>
  );
}

function Gate() {
  const { token } = useAuth();
  return token ? <Shell /> : <LoginPage />;
}

export function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
