import { useEffect, useState } from "react";
import { api, AgiGoal as Goal, AgiKpi, AgiSkill } from "../../api/client";

export function kpiGap(k: AgiKpi): number | null {
  if (k.current === undefined) return null;
  if (k.direction === "max") return Math.max(0, (k.target - k.current) / (k.target || 1));
  return k.current <= k.target ? 0 : 1;
}

const AUTONOMY = ["0 read-only", "1 sandbox", "2 staging", "3 prod + approval"];

export function AgiGoal({ tick, isAdmin }: { tick: number; isAdmin: boolean }) {
  const [g, setG] = useState<Goal | null>(null);
  const [skills, setSkills] = useState<AgiSkill[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const reload = () => api.agiGoal().then(setG).catch((e) => setMsg(e.message));
  useEffect(() => { void reload(); api.agiSkills().then(setSkills).catch(() => {}); }, [tick]);
  if (!g) return <p className="agi-dim">{msg || "Loading…"}</p>;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setMsg(`${label}…`);
    try { await fn(); setMsg(`${label} done`); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setBusy(false); void reload();
  };

  return (
    <div>
      <p className="agi-goal">“{g.statement}”</p>
      {isAdmin && (
        <form className="agi-toolbar" onSubmit={(e) => { e.preventDefault(); const t = draft.trim(); if (t) void run("Saving goal", async () => { await api.agiSetGoal({ statement: t }); setDraft(""); }); }}>
          <input style={{ flex: 1, minWidth: 200 }} maxLength={500} value={draft} disabled={busy} placeholder="Set a new goal (max 500 chars)" aria-label="New goal" onChange={(e) => setDraft(e.target.value)} />
          <button className="btn btn-sm" type="submit" disabled={busy || !draft.trim()}>Set goal</button>
        </form>
      )}
      <div className="agi-toolbar">
        <label>Autonomy{" "}
          <select disabled={!isAdmin} value={g.autonomy} onChange={(e) => void run("Updating autonomy", () => api.agiSetGoal({ autonomy: Number(e.target.value) }))}>
            {AUTONOMY.map((label, i) => <option key={i} value={i}>{label}</option>)}
          </select>
        </label>
      </div>
      <table className="agi-table">
        <thead><tr><th>KPI</th><th>Now</th><th>Target</th><th><span className="sr-only">Status</span></th></tr></thead>
        <tbody>
          {g.kpis.map((k) => {
            const gp = kpiGap(k);
            const cls = gp === null ? "na" : gp === 0 ? "good" : gp < 0.3 ? "mid" : "bad";
            return (
              <tr key={k.name}>
                <td>{k.name}</td><td>{k.current ?? "–"}</td><td>{k.direction === "max" ? "≥" : "≤"} {k.target}</td>
                <td><span className={`agi-dot agi-dot-${cls}`} role="img" aria-label={cls === "na" ? "not measured" : cls === "good" ? "on target" : cls === "mid" ? "near target" : "off target"} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {isAdmin && (
        <div className="agi-toolbar">
          <button className="btn btn-sm" disabled={busy} onClick={() => void run("Measuring", api.agiMeasure)}>Measure KPIs</button>
          <button className="btn btn-sm" disabled={busy} onClick={() => void run("Practicing", api.agiPractice)}>Practice (learn)</button>
          <button className="btn btn-sm" disabled={busy} onClick={() => void run("Evolving", api.agiPropose)}>Evolve now</button>
        </div>
      )}
      <p className="agi-dim" aria-live="polite">{msg}</p>
      <h4 className="agi-h">Constraints</h4>
      <ul>{g.constraints.map((c) => <li key={c}>{c}</li>)}</ul>
      <h4 className="agi-h">Verified skills ({skills.length})</h4>
      {skills.length === 0
        ? <p className="agi-dim">None yet. Skills are saved only after their own test passes in the sandbox.</p>
        : <ul>{skills.map((s) => <li key={s.name}><strong>{s.name}</strong> {s.description}</li>)}</ul>}
    </div>
  );
}
