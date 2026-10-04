import { useEffect, useState } from "react";
import { api, AgiApproval } from "../../api/client";

/** Pending human-in-the-loop approvals (admin only). Refreshes on every non-span stream event. */
export function AgiApprovals({ tick }: { tick: number }) {
  const [list, setList] = useState<AgiApproval[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => { api.agiApprovals().then(setList).catch(() => {}); }, [tick]);
  if (!list.length && !err) return null;
  const decide = async (id: string, d: "approve" | "deny") => {
    try { await api.agiDecide(id, d); setList((l) => l.filter((x) => x.id !== id)); setErr(""); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="agi-approvals" role="region" aria-label="Pending approvals">
      {err && <div className="agi-note agi-note-error">{err}</div>}
      {list.map((a) => (
        <div key={a.id} className="card agi-card-warn">
          <div><strong>Approval needed</strong> <span className="agi-dim">{a.reason}</span></div>
          <pre className="agi-pre">{a.tool}: {JSON.stringify(a.args)}</pre>
          <div className="agi-dim">Predicted: {a.prediction?.predicted ?? "n/a"} (risk {a.prediction?.risk ?? "?"}, reversible {String(a.prediction?.reversible ?? "?")})</div>
          <div className="agi-row">
            <button className="btn btn-sm btn-primary" onClick={() => void decide(a.id, "approve")}>Approve</button>
            <button className="btn btn-sm btn-ghost" onClick={() => void decide(a.id, "deny")}>Deny</button>
          </div>
        </div>
      ))}
    </div>
  );
}
