import { useState, useEffect } from "react";
import { usePageActive, useOnActivate } from "../context/PageActive";
import { api, TaskHistoryEntry } from "../api/client";

export function TaskHistoryPage() {
  const [tasks, setTasks] = useState<TaskHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api
      .taskHistory(50)
      .then((r) => {
        setTasks(r.tasks);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);
  useOnActivate(load); // a task may have finished while this page was hidden

  return (
    <div className="card">
      <div className="card-title">Task history</div>
      {loading && (
        <div className="row text-2">
          <span className="spinner" /> Loading…
        </div>
      )}
      {error && <div className="badge badge-red">{error}</div>}
      {!loading && !error && tasks.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">🕘</div>
          No completed tasks yet — they'll show up here once a top-level run finishes.
        </div>
      )}
      {tasks.length > 0 && (
        <table>
          <thead>
            <tr>
              <th style={{ width: "34%" }}>Task</th>
              <th style={{ width: "34%" }}>Summary</th>
              <th>Iterations</th>
              <th>Tokens</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td>{t.task}</td>
                <td className="text-2">{t.summary}</td>
                <td>{t.iterations}</td>
                <td>{t.totalTokens?.toLocaleString() ?? "—"}</td>
                <td className="text-2">{new Date(t.timestamp).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
