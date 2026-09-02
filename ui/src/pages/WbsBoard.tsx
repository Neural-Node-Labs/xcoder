import { useState, useEffect } from "react";
import { api, WbsEntry, TaskHistoryEntry } from "../api/client";
import { StatusBadge } from "../components/Badges";

const COLUMNS: WbsEntry["status"][] = ["pending", "in_progress", "completed", "failed", "skipped"];

export function WbsBoard() {
  const [tasks, setTasks] = useState<TaskHistoryEntry[]>([]);
  const [taskId, setTaskId] = useState<string>("");
  const [entries, setEntries] = useState<WbsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .taskHistory(30)
      .then((r) => {
        setTasks(r.tasks);
        if (r.tasks[0]) setTaskId(r.tasks[0].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!taskId) return;
    setLoading(true);
    setError(null);
    api
      .wbs(taskId)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [taskId]);

  async function move(entry: WbsEntry, status: WbsEntry["status"]) {
    try {
      await api.updateWbsStatus(entry.id, status);
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, status } : e)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <div className="card">
        <div className="row-between" style={{ marginBottom: entries.length ? 16 : 0 }}>
          <div className="card-title" style={{ margin: 0 }}>
            Work breakdown structure
          </div>
          <select style={{ width: 320 }} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            {tasks.length === 0 && <option value="">No tasks yet</option>}
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.task.slice(0, 60)}
              </option>
            ))}
          </select>
        </div>

        {loading && (
          <div className="row text-2">
            <span className="spinner" /> Loading…
          </div>
        )}
        {error && <div className="badge badge-red">{error}</div>}

        {!loading && !error && entries.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">⛓</div>
            {taskId
              ? "No WBS entries for this task — it may have run as a single phase, or with a non-phase-planning engine."
              : "Run a task with phase planning enabled to see its breakdown here."}
          </div>
        )}

        {entries.length > 0 && (
          <div className="kanban">
            {COLUMNS.map((col) => {
              const colEntries = entries.filter((e) => e.status === col);
              return (
                <div className="kanban-col" key={col}>
                  <div className="kanban-col-title">
                    <span>{col.replace("_", " ")}</span>
                    <span>{colEntries.length}</span>
                  </div>
                  {colEntries.map((entry) => (
                    <div className="kanban-card" key={entry.id}>
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>
                        Phase {entry.phaseNumber}: {entry.phaseTitle}
                      </div>
                      <div className="text-2" style={{ marginBottom: 8 }}>
                        {entry.taskDescription.slice(0, 90)}
                      </div>
                      <select
                        value={entry.status}
                        onChange={(e) => move(entry, e.target.value as WbsEntry["status"])}
                        style={{ fontSize: 11, padding: 4 }}
                      >
                        {COLUMNS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {taskId && <PhaseReports taskId={taskId} />}
    </div>
  );
}

function PhaseReports({ taskId }: { taskId: string }) {
  const [reports, setReports] = useState<{ id: string; phaseNumber: number; phaseTitle: string; tokens: number; iterations: number }[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");

  useEffect(() => {
    api
      .phaseReports(taskId)
      .then((r) => setReports(r.reports))
      .catch(() => setReports([]));
    setOpenId(null);
  }, [taskId]);

  async function open(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    const report = await api.phaseReport(id);
    setContent(report.content);
    setOpenId(id);
  }

  if (reports.length === 0) return null;

  return (
    <div className="card">
      <div className="card-title">Phase reports</div>
      {reports.map((r) => (
        <div key={r.id} style={{ marginBottom: 8 }}>
          <div className="row-between" style={{ cursor: "pointer" }} onClick={() => open(r.id)}>
            <div className="row" style={{ gap: 10 }}>
              <StatusBadge status="completed" />
              <span style={{ fontWeight: 600 }}>
                Phase {r.phaseNumber}: {r.phaseTitle}
              </span>
            </div>
            <div className="text-2">
              {r.tokens.toLocaleString()} tokens · {r.iterations} iter
            </div>
          </div>
          {openId === r.id && <pre className="console" style={{ marginTop: 10 }}>{content}</pre>}
        </div>
      ))}
    </div>
  );
}
