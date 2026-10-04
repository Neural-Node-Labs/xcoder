import { useMemo, useState } from "react";
import type { SpanMap, SpanRec } from "./agiEvents";

const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);

export function spanLabel(s: SpanRec): string {
  const a = s.attrs;
  switch (s.name) {
    case "agi.run": return `run [${str(a["agi.mode"], 20)}] ${str(a["agi.message"], 70)}`;
    case "agi.task": return `task: ${str(a["agi.task.goal"], 70)}`;
    case "agi.tool": return `tool ${str(a["tool.name"], 40)} ${str(a["tool.args"], 80)}`;
    case "llm.call": return `llm ${str(a["llm.role"], 20)} (${str(a["llm.tier"], 20)})`;
    case "agi.verify": return `verify → ${a["verify.pass"] === undefined ? "…" : a["verify.pass"] ? "pass" : "FAIL"}`;
    case "evolve.cycle": return `evolution ${str(a["evolve.id"], 20)} (base ${str(a["evolve.base"], 20)})`;
    default: return s.name;
  }
}

function Node({ s, kids, depth, showLlm }: { s: SpanRec; kids: Record<string, SpanRec[]>; depth: number; showLlm: boolean }) {
  const [open, setOpen] = useState(false);
  const children = (kids[s.id] ?? []).filter((c) => showLlm || c.name !== "llm.call").sort((a, b) => a.start - b.start);
  const policy = s.events?.find((e) => e.name === "policy");
  const verdict = policy ? String(policy.attrs.verdict ?? "") : "";
  const state = !s.done ? "run" : s.error ? "err" : "ok";
  return (
    <div>
      <button type="button" className={`agi-span agi-span-${state}`} style={{ paddingLeft: depth * 14 }} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="agi-ic" aria-hidden>{state === "run" ? "○" : state === "err" ? "✗" : "✓"}</span>
        <span className="agi-nm">{spanLabel(s)}</span>
        {verdict && verdict !== "allow" && <span className={`agi-tag agi-tag-${verdict}`}>{verdict}</span>}
        <span className="agi-ms">{s.ms !== undefined ? `${s.ms} ms` : ""}</span>
      </button>
      {open && <pre className="agi-pre agi-attrs" style={{ marginLeft: depth * 14 + 18 }}>{JSON.stringify({ ...s.attrs, error: s.error, events: s.events }, null, 1)}</pre>}
      {children.map((c) => <Node key={c.id} s={c} kids={kids} depth={depth + 1} showLlm={showLlm} />)}
    </div>
  );
}

/** Live OpenTelemetry trace tree of the AGI agent's runs (admin only). */
export function AgiActivity({ spans }: { spans: SpanMap }) {
  const [showLlm, setShowLlm] = useState(false);
  const [showEval, setShowEval] = useState(false);
  const { roots, kids } = useMemo(() => {
    const all = Object.values(spans);
    const kids: Record<string, SpanRec[]> = {};
    for (const s of all) if (s.parent && spans[s.parent]) (kids[s.parent] ??= []).push(s);
    const roots = all
      .filter((s) => !s.parent || !spans[s.parent])
      .filter((s) => ["agi.run", "evolve.cycle", "evolve.baseline"].includes(s.name))
      .filter((s) => showEval || !String(s.attrs["agi.run_id"] ?? "").startsWith("eval-"))
      .sort((a, b) => b.start - a.start)
      .slice(0, 12);
    return { roots, kids };
  }, [spans, showEval]);
  return (
    <div>
      <div className="agi-toolbar">
        <label><input type="checkbox" checked={showLlm} onChange={(e) => setShowLlm(e.target.checked)} /> LLM calls</label>
        <label><input type="checkbox" checked={showEval} onChange={(e) => setShowEval(e.target.checked)} /> eval runs</label>
        <span className="agi-dim">live OpenTelemetry spans from the agent</span>
      </div>
      {roots.length === 0 && <p className="agi-dim">No activity yet. Send a chat message or press “Measure KPIs”.</p>}
      {roots.map((r) => <Node key={r.id} s={r} kids={kids} depth={0} showLlm={showLlm} />)}
    </div>
  );
}
