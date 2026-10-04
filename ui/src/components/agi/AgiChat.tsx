import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";

interface Msg { role: "user" | "agent"; text: string; meta?: string; error?: boolean }

const WELCOME: Msg = { role: "agent", text: "Give me a DevOps task. I work only inside an isolated sandbox and ask an admin before anything destructive." };

export function AgiChat({ disabled, disabledReason }: { disabled: boolean; disabledReason?: string }) {
  const [log, setLog] = useState<Msg[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [log, busy]);

  async function send() {
    const message = input.trim();
    if (!message || busy || disabled) return;
    const history = log.filter((m) => !m.error).slice(-6).map((m) => ({ role: m.role, text: m.text }));
    setLog((l) => [...l, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    try {
      const r = await api.agiChat(message, history);
      const blocked = r.violations?.length ?? 0;
      const meta = `${r.status} · ${r.steps} steps · ${r.tokens} tokens · ${Number(r.seconds).toFixed(1)}s${blocked ? ` · ${blocked} policy violation(s) blocked` : ""}`;
      setLog((l) => [...l, { role: "agent", text: r.answer, meta }]);
    } catch (e) {
      setLog((l) => [...l, { role: "agent", text: e instanceof Error ? e.message : String(e), error: true }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="agi-chat">
      <div className="agi-msgs" role="log" aria-live="polite" aria-label="AGI conversation">
        {log.map((m, i) => (
          <div key={i} className={`agi-msg agi-msg-${m.role}`}>
            <div className={`agi-bubble${m.error ? " agi-bubble-error" : ""}`}>{m.text}</div>
            {m.meta && <div className="agi-meta">{m.meta}</div>}
          </div>
        ))}
        {busy && <div className="agi-msg agi-msg-agent"><div className="agi-bubble agi-dim">Working in the sandbox…</div></div>}
        <div ref={end} />
      </div>
      <form className="agi-inputrow" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor="agi-chat-input">Message to the AGI agent</label>
        <input
          id="agi-chat-input"
          value={input}
          maxLength={4000}
          disabled={disabled}
          placeholder={disabled ? disabledReason ?? "Unavailable" : "e.g. fix deployment.yaml, or: hello"}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || disabled || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
