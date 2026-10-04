import { useCallback, useEffect, useState } from "react";
import { api, AgiSchedule } from "../../api/client";

const STATE_TEXT: Record<AgiSchedule["state"], string> = {
  off: "Off", idle: "On — waiting for next cycle", running: "On — cycle running now",
  "waiting-allowance": "On — paused, token allowance used up", blocked: "On — blocked",
};

export const fmtTime = (t: number | null) => (t ? new Date(t).toLocaleString() : "—");
export const fmtTokens = (n: number) => n.toLocaleString("en-US");
/** Browser's UTC offset in minutes east of UTC (Manila = 480). */
export const browserOffsetMin = () => -new Date().getTimezoneOffset();
export const offsetLabel = (m: number) => `UTC${m < 0 ? "-" : "+"}${String(Math.floor(Math.abs(m) / 60)).padStart(2, "0")}:${String(Math.abs(m) % 60).padStart(2, "0")}`;

/**
 * Autonomous mode (admin only). When enabled the agent runs a cycle (measure KPIs, then try to improve the weakest)
 * every N minutes, spends from a daily token allowance, pauses when it is used up and resumes by itself when it
 * refills. Everything is enforced by the AGI service, so this page closing or reloading changes nothing.
 */
export function AgiSchedulePanel({ tick }: { tick: number }) {
  const [s, setS] = useState<AgiSchedule | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ everyMinutes: string; dailyTokens: string; reset: "daily" | "rolling"; tzOffsetMin: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const v = await api.agiSchedule(); setS(v); setErr("");
      setForm((f) => f ?? { everyMinutes: String(v.everyMinutes), dailyTokens: String(v.dailyTokens), reset: v.reset, tzOffsetMin: String(v.enabled || v.tzOffsetMin ? v.tzOffsetMin : browserOffsetMin()) });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load, tick]);
  useEffect(() => { const id = setInterval(() => void load(), 15_000); return () => clearInterval(id); }, [load]);

  if (!s || !form) return <p className="agi-dim">{err || "Loading…"}</p>;

  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const apply = async (extra: { enabled?: boolean } = {}) => {
    const body = { everyMinutes: num(form.everyMinutes), dailyTokens: num(form.dailyTokens), reset: form.reset, tzOffsetMin: num(form.tzOffsetMin), ...extra };
    if (![body.everyMinutes, body.dailyTokens, body.tzOffsetMin].every(Number.isInteger)) { setErr("Enter whole numbers."); return; }
    setBusy(true);
    try { setS(await api.agiSetSchedule(body)); setErr(""); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  const pct = s.dailyTokens ? Math.min(100, Math.round((s.usedTokens / s.dailyTokens) * 100)) : 0;
  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });

  return (
    <div>
      <div className="agi-toolbar">
        <strong>{STATE_TEXT[s.state]}</strong>
        <button className="btn btn-sm" disabled={busy} onClick={() => void apply({ enabled: !s.enabled })}>{s.enabled ? "Stop autonomous mode" : "Start autonomous mode"}</button>
      </div>
      {s.blockedReason && <div className="agi-note agi-note-error">Not running: {s.blockedReason}</div>}

      <div role="progressbar" aria-label="Tokens used this window" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="agi-meter"><div className="agi-meter-fill" style={{ width: `${pct}%` }} /></div>
      <p className="agi-dim">{fmtTokens(s.usedTokens)} of {fmtTokens(s.dailyTokens)} tokens used ({fmtTokens(s.remainingTokens)} left)</p>
      {s.enabled && <p className="agi-dim">{s.refillsAt ? `Allowance refills ${fmtTime(s.refillsAt)}. ` : ""}Next cycle: {fmtTime(s.nextRunAt)}</p>}
      {s.lastRun && <p className="agi-dim">Last cycle {fmtTime(s.lastRun.at)}: {s.lastRun.outcome} ({fmtTokens(s.lastRun.tokens)} tokens){s.lastRun.ok ? "" : " — did not complete"}</p>}
      {s.lastError && <div className="agi-note agi-note-error">Last error: {s.lastError}</div>}

      <h4 className="agi-h">Settings</h4>
      <form className="agi-form" onSubmit={(e) => { e.preventDefault(); void apply(); }}>
        <label>Run a cycle every (minutes)<input type="number" min={5} max={10080} step={1} value={form.everyMinutes} onChange={(e) => set("everyMinutes", e.target.value)} /></label>
        <label>Token allowance per window<input type="number" min={10000} max={100000000} step={1000} value={form.dailyTokens} onChange={(e) => set("dailyTokens", e.target.value)} /></label>
        <label>Allowance refills
          <select value={form.reset} onChange={(e) => set("reset", e.target.value)}>
            <option value="daily">at midnight ({offsetLabel(Number(form.tzOffsetMin) || 0)})</option>
            <option value="rolling">24 hours after first use</option>
          </select>
        </label>
        <label>Timezone offset (minutes east of UTC)<input type="number" min={-840} max={840} step={15} value={form.tzOffsetMin} onChange={(e) => set("tzOffsetMin", e.target.value)} disabled={form.reset === "rolling"} /></label>
        <button className="btn btn-sm" type="submit" disabled={busy}>Save settings</button>
      </form>
      <p className="agi-dim">A cycle won't start with under 5,000 tokens left, and a running cycle is stopped when the allowance is reached (it can overshoot by one model call). Chat is never blocked by the allowance but its tokens count toward it. Changes that need approval still wait for an admin, and the kill switch pauses everything.</p>
      {err && <div className="agi-note agi-note-error" role="alert">{err}</div>}
    </div>
  );
}
