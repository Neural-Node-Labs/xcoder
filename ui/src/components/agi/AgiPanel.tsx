import { useEffect, useState } from "react";
import { api, AgiStatus } from "../../api/client";
import { useAgiEvents } from "./agiEvents";
import { AgiChat } from "./AgiChat";
import { AgiActivity } from "./AgiActivity";
import { AgiGoal } from "./AgiGoal";
import { AgiEvolution } from "./AgiEvolution";
import { AgiSchedulePanel } from "./AgiSchedule";
import { AgiApprovals } from "./AgiApprovals";
import "./agi.css";

type TabId = "Activity" | "Goal" | "Schedule" | "Evolution";

function SetupCard({ status, onRetry }: { status: AgiStatus | null; onRetry: () => void }) {
  if (!status) return <div className="card"><p className="agi-dim">Checking the AGI service…</p></div>;
  if (!status.configured) {
    return (
      <div className="card agi-setup">
        <div className="card-title">AGI DevOps agent is not set up</div>
        <p>The AGI harness runs as its own isolated service (agent + network-less sandbox). Start it alongside xcoder:</p>
        <pre className="agi-pre">{`# .env  (secrets: 16+ random chars each; the agent refuses weak ones)
XCODER_AGI_URL=http://agi:7000
AGI_API_TOKEN=<long random secret>
SANDBOX_TOKEN=<another long random secret>
# optional: LLM_MODE=anthropic  (uses ANTHROPIC_API_KEY)

docker compose -f docker-compose.yml -f docker-compose.agi.yml up -d --build`}</pre>
        <p className="agi-dim">Without an API key it runs in offline mock mode, which solves the built-in scenarios with scripted answers so you can see the whole pipeline. See integrations/agi/XCODER_INTEGRATION.md.</p>
      </div>
    );
  }
  return (
    <div className="card agi-setup">
      <div className="card-title">AGI service unreachable</div>
      <p className="agi-dim">{status.error ?? "No response from the AGI service."} It may still be starting (the sandbox must become healthy first).</p>
      <button className="btn btn-sm" onClick={onRetry}>Retry</button>
    </div>
  );
}

/**
 * The AGI tab: chat with the DevOps agent plus (admins) live activity, goal/KPIs, evolution and
 * approvals. Talks only to xcoder's authenticated gateway (/api/v1/agi/*), never to the AGI
 * service directly. Stays mounted once opened (like Chat) so the conversation survives tab
 * switches; `visible` pauses polling while hidden.
 */
export function AgiPanel({ visible }: { visible: boolean }) {
  const [status, setStatus] = useState<AgiStatus | null>(null);
  const [tab, setTab] = useState<TabId>("Activity");
  const [busyKill, setBusyKill] = useState(false);
  const isAdmin = status?.isAdmin === true;
  const live = status?.reachable === true;
  const { spans, tick, connected } = useAgiEvents(visible && live && isAdmin);

  const refresh = () => api.agiStatus().then(setStatus).catch((e) => setStatus({ configured: true, reachable: false, isAdmin: false, error: e instanceof Error ? e.message : String(e) }));
  useEffect(() => {
    if (!visible) return;
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [visible, tick]);

  if (!live) return <div style={{ display: visible ? "block" : "none" }}><SetupCard status={status} onRetry={() => void refresh()} /></div>;

  const killed = status?.killed === true;
  const toggleKill = async () => {
    if (!killed && !confirm("Stop all autonomous AGI operations?")) return;
    setBusyKill(true);
    try { await (killed ? api.agiKillReset() : api.agiKill()); } catch { /* status refresh below shows the truth */ }
    setBusyKill(false);
    void refresh();
  };
  const tabs: TabId[] = ["Activity", "Goal", "Schedule", "Evolution"];

  return (
    <div className="agi-panel" style={{ display: visible ? "flex" : "none" }}>
      <div className="agi-header">
        {isAdmin && <span className={`badge ${connected ? "badge-green" : "badge-red"}`}>{connected ? "live" : "offline"}</span>}
        <span className="badge">release {status?.release}</span>
        <span className={`badge ${status?.llmMode === "mock" ? "badge-amber" : "badge-blue"}`}>llm: {status?.llmMode}</span>
        <span className={`badge ${status?.sandbox ? "badge-green" : "badge-red"}`}>sandbox {status?.sandbox ? "isolated, up" : "down"}</span>
        <span className={`badge ${status?.probation === "fail" ? "badge-red" : ""}`}>probation {status?.probation}</span>
        <span className="agi-grow" />
        {isAdmin && (
          <button className={`btn btn-sm ${killed ? "btn-primary" : "btn-danger"}`} disabled={busyKill} onClick={() => void toggleKill()}>
            {killed ? "Resume" : "KILL"}
          </button>
        )}
      </div>
      {killed && <div className="agi-note agi-note-error" role="alert">Kill switch engaged — the agent is halted{isAdmin ? "." : "; ask an admin to resume."}</div>}
      {status?.llmMode === "mock" && <div className="agi-note">Offline mock mode: answers are scripted, not from a real model.</div>}
      <div className={`agi-grid${isAdmin ? "" : " agi-grid-single"}`}>
        <section className="agi-left" aria-label="AGI chat">
          {isAdmin && <AgiApprovals tick={tick} />}
          <AgiChat disabled={killed} disabledReason="Kill switch engaged" />
        </section>
        {isAdmin ? (
          <section className="agi-right">
            <div className="agi-tabs" role="tablist">
              {tabs.map((t) => <button key={t} role="tab" aria-selected={t === tab} className={`agi-tab${t === tab ? " agi-tab-active" : ""}`} onClick={() => setTab(t)}>{t}</button>)}
            </div>
            <div className="agi-tabpanel" role="tabpanel">
              {tab === "Activity" && <AgiActivity spans={spans} />}
              {tab === "Goal" && <AgiGoal tick={tick} isAdmin />}
              {tab === "Schedule" && <AgiSchedulePanel tick={tick} />}
              {tab === "Evolution" && <AgiEvolution tick={tick} />}
            </div>
          </section>
        ) : (
          <section className="agi-right" aria-label="AGI goal">
            <AgiGoal tick={tick} isAdmin={false} />
            <p className="agi-dim">Activity, approvals and evolution are visible to administrators only.</p>
          </section>
        )}
      </div>
    </div>
  );
}
