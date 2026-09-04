import { useState, useRef, useEffect } from "react";
import { api, Project } from "../api/client";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Direct chat with the "assistant" orchestration engine (see EngineRegistry.ts) — for
 * conversation and small one-off requests, as opposed to the full "Task" tab's SDLC pipeline.
 *
 * There's no server-side session/thread concept for /chat (it's a single stateless request per
 * call — see ChatRequest/ChatResponse in src/api/types.ts), so this keeps the conversation
 * client-side and replays it as context on every turn.
 */
export function ChatPanel({ projects }: { projects: Project[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  function buildPrompt(nextUserMessage: string): string {
    // No multi-turn session on the server, so the running transcript is folded back into
    // the task text each turn — enough for the model to stay coherent across a short chat
    // without needing a new backend concept just for this tab.
    if (messages.length === 0) return nextUserMessage;
    const history = messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
    return `${history}\n\nUser: ${nextUserMessage}`;
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setError(null);
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setBusy(true);
    try {
      const res = await api.chat({
        task: buildPrompt(text),
        engine: "assistant",
        planMode: "never",
        projectId: projectId || undefined,
      });
      setMessages((prev) => [...prev, { role: "assistant", content: res.result }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Roll back the optimistic user message's turn so a retry doesn't duplicate it in history
      setMessages((prev) => prev.slice(0, -1));
      setInput(text);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="card">
      <div className="row-between" style={{ marginBottom: 12 }}>
        <div className="card-title" style={{ margin: 0 }}>
          Chat with Assistant
        </div>
        {projects.length > 0 && (
          <select style={{ width: 200 }} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">(active project / server cwd)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="chat-thread" ref={threadRef}>
        {messages.length === 0 && !busy && (
          <div className="empty-state">
            <div className="empty-state-icon">💬</div>
            Ask the Assistant engine anything — it can chat, answer questions, or use tools, skills, and MCP servers for quick tasks.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-bubble ${m.role === "user" ? "chat-bubble-user" : "chat-bubble-assistant"}`}>
            {m.content}
          </div>
        ))}
        {busy && (
          <div className="chat-bubble chat-bubble-assistant row" style={{ gap: 8 }}>
            <span className="spinner" /> thinking…
          </div>
        )}
      </div>

      {error && <div className="badge badge-red" style={{ marginBottom: 10, display: "flex" }}>{error}</div>}

      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message the Assistant… (Enter to send, Shift+Enter for a new line)"
          disabled={busy}
        />
        <button className="btn btn-primary" onClick={send} disabled={busy || !input.trim()}>
          {busy ? <span className="spinner" /> : "Send"}
        </button>
      </div>
    </div>
  );
}
