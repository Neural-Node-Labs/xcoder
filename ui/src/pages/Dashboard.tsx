import { useState, useEffect } from "react";
import { api, ChatResponse, EnginesResponse, Project } from "../api/client";
import { EngineBadge, HealthScore } from "../components/Badges";

type RunState =
  | { phase: "idle" }
  | { phase: "planning" }
  | { phase: "awaiting-approval"; sessionId: string; plan: string; task: string }
  | { phase: "running" }
  | { phase: "done"; response: ChatResponse | { result: string; iterations: number; limitation?: string; continueRequested?: boolean; iterationMaxReached?: boolean } }
  | { phase: "error"; message: string };

export function Dashboard() {
  const [task, setTask] = useState("");
  const [engines, setEngines] = useState<EnginesResponse | null>(null);
  const [engine, setEngine] = useState<string>("");
  const [planMode, setPlanMode] = useState<"auto" | "always" | "never">("auto");
  const [phasePlanning, setPhasePlanning] = useState(false);
  const [isolatedWorkspace, setIsolatedWorkspace] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const [mockLlm, setMockLlm] = useState(false);

  useEffect(() => {
    api.engines().then((e) => {
      setEngines(e);
      setEngine(e.default);
    }).catch(() => {});
    api.projects().then(setProjects).catch(() => {});
    api.health().then((h) => setMockLlm(h.mockLlm)).catch(() => {});
  }, []);

  async function submitTask() {
    if (!task.trim()) return;
    setRun({ phase: "planning" });
    try {
      if (planMode === "never") {
        setRun({ phase: "running" });
        const response = await api.chat({
          task: task.trim(),
          engine,
          planMode,
          phasePlanning,
          isolatedWorkspace,
          projectId: projectId || undefined,
        });
        setRun({ phase: "done", response });
      } else {
        const planRes = await api.plan({
          task: task.trim(),
          engine,
          planMode,
          phasePlanning,
          isolatedWorkspace,
          projectId: projectId || undefined,
        });
        setRun({ phase: "awaiting-approval", sessionId: planRes.sessionId, plan: planRes.plan, task: planRes.task });
      }
    } catch (err) {
      setRun({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function approvePlan() {
    if (run.phase !== "awaiting-approval") return;
    setRun({ phase: "running" });
    try {
      const response = await api.execute(run.sessionId);
      setRun({ phase: "done", response });
    } catch (err) {
      setRun({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function reset() {
    setTask("");
    setRun({ phase: "idle" });
  }

  return (
    <div>
      {mockLlm && (
        <div className="badge badge-amber" style={{ display: "flex", marginBottom: 14 }}>
          ⚠ This server is running with a MOCK LLM connection — task results below are
          simulated, not real model output. See Settings for details.
        </div>
      )}
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="card">
          <div className="card-title">New task</div>

          <div className="field">
            <label>What should xcoder do?</label>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder='e.g. "Add rate limiting middleware to the /api/v1 routes and write tests for it"'
              disabled={run.phase !== "idle" && run.phase !== "error"}
            />
          </div>

          <div className="grid grid-2">
            <div className="field">
              <label>Engine</label>
              <select value={engine} onChange={(e) => setEngine(e.target.value)} disabled={!engines}>
                {engines?.engines.map((e) => (
                  <option key={e} value={e}>
                    {e}
                    {e === engines.default ? " (default)" : ""}
                  </option>
                ))}
              </select>
              <div className="field-hint">
                {engine === "sdlc"
                  ? "DAG-based SDLC pipeline with an independent Validation Gate per stage."
                  : engine
                  ? "See src/core/engine/EngineRegistry.ts for what this engine does."
                  : ""}
              </div>
            </div>

            <div className="field">
              <label>Project</label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">(active project / server cwd)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.active ? " · active" : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-2">
            <div className="field">
              <label>Plan mode</label>
              <select value={planMode} onChange={(e) => setPlanMode(e.target.value as typeof planMode)}>
                <option value="auto">Auto (plan for non-trivial tasks)</option>
                <option value="always">Always ask for approval</option>
                <option value="never">Never — run immediately</option>
              </select>
            </div>
            <div className="field">
              <label>Options</label>
              <div className="row" style={{ gap: 14, paddingTop: 8 }}>
                <label className="row" style={{ gap: 6, fontWeight: 400, fontSize: 12 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={phasePlanning} onChange={(e) => setPhasePlanning(e.target.checked)} />
                  Phase planning
                </label>
                <label className="row" style={{ gap: 6, fontWeight: 400, fontSize: 12 }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={isolatedWorkspace} onChange={(e) => setIsolatedWorkspace(e.target.checked)} />
                  Isolated workspace
                </label>
              </div>
            </div>
          </div>

          <div className="row" style={{ marginTop: 4 }}>
            {run.phase === "idle" || run.phase === "error" ? (
              <button className="btn btn-primary" onClick={submitTask} disabled={!task.trim()}>
                ▶ Run task
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={reset} disabled={run.phase === "planning" || run.phase === "running"}>
                ↺ New task
              </button>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-title">Result</div>
          <RunOutput run={run} onApprove={approvePlan} />
        </div>
      </div>
    </div>
  );
}

function RunOutput({ run, onApprove }: { run: RunState; onApprove: () => void }) {
  if (run.phase === "idle") {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⌗</div>
        Submit a task to see it run here.
      </div>
    );
  }

  if (run.phase === "planning") {
    return (
      <div className="row" style={{ color: "var(--text-1)" }}>
        <span className="spinner" /> Drafting a plan…
      </div>
    );
  }

  if (run.phase === "awaiting-approval") {
    return (
      <div>
        <div className="badge badge-amber" style={{ marginBottom: 12 }}>
          Awaiting approval
        </div>
        <pre className="console" style={{ whiteSpace: "pre-wrap" }}>{run.plan}</pre>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={onApprove}>
            ✓ Approve &amp; run
          </button>
        </div>
      </div>
    );
  }

  if (run.phase === "running") {
    return (
      <div className="row" style={{ color: "var(--text-1)" }}>
        <span className="spinner" /> Running — check "Live logs" in the sidebar to watch thought / action / observation as it happens.
      </div>
    );
  }

  if (run.phase === "error") {
    return <div className="badge badge-red" style={{ display: "flex" }}>{run.message}</div>;
  }

  // done
  const r = run.response;
  const isFullChat = "usage" in r;
  return (
    <div>
      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <span className="badge">{r.iterations} iteration{r.iterations === 1 ? "" : "s"}</span>
        {isFullChat && r.healthScore !== undefined && <HealthScore score={r.healthScore} />}
        {isFullChat && r.usage && <span className="badge">{r.usage.totalTokens.toLocaleString()} tokens</span>}
        {r.limitation && <span className="badge badge-red">{r.limitation}</span>}
      </div>
      <pre className="console" style={{ whiteSpace: "pre-wrap" }}>{r.result}</pre>
    </div>
  );
}
