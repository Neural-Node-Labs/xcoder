import { useEffect, useState } from "react";
import { api, AgiEvolution as Evo } from "../../api/client";

export function AgiEvolution({ tick }: { tick: number }) {
  const [d, setD] = useState<{ running: boolean; items: Evo[] }>({ running: false, items: [] });
  const [err, setErr] = useState("");
  useEffect(() => {
    const f = () => api.agiEvolutions().then(setD).catch(() => {});
    f();
    const t = setInterval(f, 3000);
    return () => clearInterval(t);
  }, [tick]);
  const act = (fn: () => Promise<unknown>) => fn().then(() => setErr("")).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  return (
    <div>
      <div className="agi-toolbar">
        <button className="btn btn-sm" disabled={d.running} onClick={() => void act(api.agiPropose)}>{d.running ? "Cycle running…" : "Propose evolution"}</button>
        <span className="agi-dim">Candidates are tested in the sandbox, gated, promoted by the supervisor, and rolled back automatically on failure.</span>
      </div>
      {err && <div className="agi-note agi-note-error">{err}</div>}
      {d.items.length === 0 && <p className="agi-dim">No evolutions yet.</p>}
      {d.items.map((e) => (
        <div key={e.id} className="card agi-evo">
          <div className="agi-row"><strong>{e.id}</strong> <span className={`badge agi-status agi-status-${e.status}`}>{e.status.replace(/_/g, " ")}</span> <span className="agi-dim">{e.tier} · target {e.targetKpi} · from {e.baseVersion}</span></div>
          <div className="agi-dim">{e.rationale}</div>
          {e.baselineScore !== undefined && <div>score {e.baselineScore} → {e.candidateScore}</div>}
          {e.gates.map((g) => <div key={g.name} className={g.pass ? "agi-gate-pass" : "agi-gate-fail"}>{g.pass ? "✓" : "✗ FAIL"} {g.name}: <span className="agi-dim">{g.detail}</span></div>)}
          {e.note && <div className="agi-dim">{e.note}</div>}
          {e.status === "awaiting_approval" && (
            <div className="agi-row">
              <button className="btn btn-sm btn-primary" onClick={() => void act(() => api.agiEvolutionDecide(e.id, "approve"))}>Approve and promote</button>
              <button className="btn btn-sm btn-ghost" onClick={() => void act(() => api.agiEvolutionDecide(e.id, "reject"))}>Reject</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
