import { useState, useEffect, useCallback } from "react";
import { usePageActive, useOnActivate } from "../context/PageActive";
import { api, ChatResponse, EnginesResponse, Project } from "../api/client";
import { HealthScore } from "../components/Badges";
import { ChatPanel } from "../components/ChatPanel";
import { useSpeechRecognition, useSpeechSynthesis, useUiSounds } from "../hooks/useSpeech";
import { VoiceButton, SpeakToggle, SoundToggle, InterimTranscript } from "../components/VoiceControls";

type RunState =
  | { phase: "idle" }
  | { phase: "planning" }
  | { phase: "awaiting-approval"; sessionId: string; plan: string; task: string }
  | { phase: "running" }
  | { phase: "done"; response: ChatResponse | { result: string; iterations: number; limitation?: string; continueRequested?: boolean; iterationMaxReached?: boolean } }
  | { phase: "error"; message: string };

/** Short spoken status for the Task tab, used only when "read replies aloud" is on. Kept
 *  deliberately terse: these announce a state change, they don't narrate the result — the
 *  result itself is spoken separately when the run finishes. */
function spokenStatusFor(run: RunState): string | null {
  switch (run.phase) {
    case "awaiting-approval":
      return "The plan is ready for your approval.";
    case "error":
      return `The task failed. ${run.message}`;
    default:
      return null;
  }
}

export function Dashboard() {
  const [tab, setTab] = useState<"task" | "chat">("task");
  // Chat mounts the first time it's opened and then stays mounted (hidden) when you switch to the
  // Task tab — its transcript lives in ChatPanel's own state, so unmounting it wiped the
  // conversation every time you toggled tabs.
  const [chatOpened, setChatOpened] = useState(false);
  const pageActive = usePageActive();
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

  const synthesis = useSpeechSynthesis();
  const sounds = useUiSounds();
  const onTranscript = useCallback((text: string) => {
    setTask((prev) => (prev ? `${prev.replace(/\s+$/, "")} ${text}` : text));
  }, []);
  const recognition = useSpeechRecognition(onTranscript);

  useEffect(() => {
    api.engines().then((e) => {
      setEngines(e);
      setEngine(e.default);
    }).catch(() => {});
    api.projects().then(setProjects).catch(() => {});
    api.health().then((h) => setMockLlm(h.mockLlm)).catch(() => {});
  }, []);

  // Kept mounted across navigation so the task text, chat transcript and any run in flight
  // survive. Refresh just the lists other pages can change (projects, engines); never touch the
  // current selections or the draft.
  useOnActivate(() => {
    api.projects().then(setProjects).catch(() => {});
    api.engines().then(setEngines).catch(() => {});
  });

  // Kept mounted while hidden, so unmounting no longer implicitly silences voice output or
  // releases the mic — do it explicitly whenever the Task tab isn't the thing on screen.
  const taskShown = pageActive && tab === "task";
  useEffect(() => {
    if (taskShown) return;
    synthesis.cancel();
    if (recognition.listening) recognition.stop();
    // Keyed on visibility only; cancel/stop are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskShown]);

  async function submitTask() {
    if (!task.trim()) return;
    // Leaving the mic open across a run would keep dictating into a disabled textarea.
    if (recognition.listening) recognition.stop();
    sounds.play("send");
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
    synthesis.cancel();
  }

  // Cues and spoken status are driven off the run state rather than fired inside submitTask()
  // and approvePlan() individually — both of those reach "done" and "error", so doing it here
  // means one code path instead of four, and no way to add a third entry point that forgets.
  useEffect(() => {
    // A run can finish while you're on another page — the result is still there when you come
    // back (and the "receive" cue still fires as a notification), but don't start reading it
    // aloud over whatever you're now doing.
    if (run.phase === "done") {
      sounds.play("receive");
      if (taskShown) synthesis.speak(run.response.result);
      return;
    }
    if (run.phase === "error") {
      sounds.play("error");
    }
    const status = spokenStatusFor(run);
    if (status && taskShown) synthesis.speak(status);
    // synthesis/sounds are stable callbacks; keying on the run phase is the intent here.
     
  }, [run]);

  return (
    <div>
      <div className="chat-tabs">
        <button className={`btn btn-sm ${tab === "task" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("task")}>
          ▶ Task
        </button>
        <button className={`btn btn-sm ${tab === "chat" ? "btn-primary" : "btn-ghost"}`} onClick={() => { setTab("chat"); setChatOpened(true); }}>
          💬 Chat
        </button>
      </div>

      {chatOpened && (
        <div style={{ display: tab === "chat" ? "contents" : "none" }}>
          <ChatPanel projects={projects} visible={tab === "chat"} />
        </div>
      )}
      {tab !== "chat" && (
        <div className="jarvis-shell jarvis-shell-task">
          {/* No Hologram here any more — it belongs to Chat. On the Task tab it sat above a
              form, pushing the actual controls below the fold, and its readout duplicated the
              Result card's text underneath it. The voice controls it used to imply live in
              the task card's own header instead. */}
          <div className="jarvis-body">
            {mockLlm && (
              <div className="badge badge-amber" style={{ display: "flex", marginBottom: 14 }}>
                ⚠ This server is running with a MOCK LLM connection — task results below are
                simulated, not real model output. See Settings for details.
              </div>
            )}

            <div className="card jarvis-task-card">
              <div className="card-title card-title-row">
                <span>New task</span>
                <span className="voice-control-group">
                  <VoiceButton recognition={recognition} />
                  <SpeakToggle synthesis={synthesis} />
                  <SoundToggle sounds={sounds} />
                </span>
              </div>

              <div className="field">
                <label>What should xcoder do?</label>
                <textarea
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder='e.g. "Add rate limiting middleware to the /api/v1 routes and write tests for it"'
                  disabled={run.phase !== "idle" && run.phase !== "error"}
                />
                <InterimTranscript recognition={recognition} />
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

            <div className="card jarvis-task-card">
              <div className="card-title">Result</div>
              <RunOutput run={run} onApprove={approvePlan} />
            </div>
          </div>
        </div>
      )}
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
