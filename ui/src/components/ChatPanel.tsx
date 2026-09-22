import { useState, useRef, useEffect, useCallback } from "react";
import { api, ModelListResponse, Project } from "../api/client";
import { Hologram } from "./Hologram";
import { JarvisHologram, JarvisMood } from "./JarvisHologram";
import { useAssistantName } from "../assistantName";
import { useSpeechRecognition, useSpeechSynthesis, useUiSounds } from "../hooks/useSpeech";
import { VoiceButton, SpeakToggle, SoundToggle, InterimTranscript } from "./VoiceControls";
import { usePageActive } from "../context/PageActive";

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
 *
 * Laid out as a centered console with the Hologram standing in for the assistant (see
 * assistantName.ts — configurable in Settings, defaults to "Xcoder AI"; this used to be a
 * hardcoded "JARVIS" here and in the Hologram's default theme label, which is a trademarked
 * fictional name this app has no claim to) at the top. The
 * hologram is a presence indicator only: it shows whether the engine is idle or working, and
 * nothing else. It used to also type out a truncated copy of the latest reply, which meant
 * every answer appeared twice on screen — once clipped in the hologram, once in full in the
 * bubble right below it. The transcript is the one place replies live now.
 *
 * Alongside it sits a small <JarvisHologram> mood badge — a separate concept from the Hologram
 * above's `theme` (a fixed visual skin the user picks) and `status` (busy/idle wording): mood
 * is the LLM's own read on the conversation, set via set_mood_tool during the run (see
 * src/tools/moodTool.ts) and returned as ChatResponse.mood. It persists server-side per
 * workspace until the tool is called again, so this badge reflects whatever the *last* chat
 * response said the mood was — including on the very first message of a session, where that
 * mood may already be non-default (a previous chat, possibly from another browser tab, could
 * have set it, or it could be the workspace's first-ever random pick — see moodTool.ts).
 */
export function ChatPanel({ projects, visible = true }: { projects: Project[]; visible?: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelInfo, setModelInfo] = useState<ModelListResponse | null>(null);
  const [model, setModel] = useState("");
  const [mood, setMood] = useState<JarvisMood>("ready");
  const assistantName = useAssistantName();
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const synthesis = useSpeechSynthesis();
  const sounds = useUiSounds();

  // Dictation appends to whatever is already typed rather than replacing it, so a user can
  // start typing, finish by voice, or dictate several sentences in a row.
  const onTranscript = useCallback((text: string) => {
    setInput((prev) => (prev ? `${prev.replace(/\s+$/, "")} ${text}` : text));
  }, []);
  const recognition = useSpeechRecognition(onTranscript);

  // This panel stays mounted while hidden (other page, or the Task tab) so the transcript
  // survives. Unmounting used to be what silenced speech output and released the mic; now that
  // it doesn't happen implicitly, do it explicitly whenever the panel stops being on screen.
  const pageActive = usePageActive();
  const shown = pageActive && visible;
  useEffect(() => {
    if (shown) return;
    synthesis.cancel();
    if (recognition.listening) recognition.stop();
    // Keyed on visibility only; cancel/stop are stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  // Grow the input with its content, capped by the CSS max-height.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  useEffect(() => {
    api
      .models()
      .then((info) => {
        setModelInfo(info);
        // Persist the user's explicit override across reloads (a plain `useState` here reset to
        // the server default every time the page loaded, so a deliberate pick in this tab —
        // unlike everything else, which reads Settings' saved LLM config fresh) silently
        // reverted the moment you left and came back. Only honor the saved pick if it's still a
        // real option (the local Ollama model list can change between sessions); otherwise fall
        // back to whatever the server currently reports as default.
        const saved = localStorage.getItem("xcoder_chat_model");
        setModel(saved && info.models.includes(saved) ? saved : info.default);
      })
      // A failure here just means no picker — chat still works on the server's default model,
      // so there's nothing worth interrupting the user about.
      .catch(() => {});
  }, []);

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
    // Sending while the mic is open would leave it listening into the next turn with no
    // visible input to show for it.
    if (recognition.listening) recognition.stop();
    setError(null);
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setBusy(true);
    sounds.play("send");
    try {
      const res = await api.chat({
        task: buildPrompt(text),
        engine: "assistant",
        planMode: "never",
        projectId: projectId || undefined,
        // Omitted when it matches the server's own default, so a normal request carries no
        // override at all and the server stays free to change its default.
        model: model && model !== modelInfo?.default ? model : undefined,
      });
      setMessages((prev) => [...prev, { role: "assistant", content: res.result }]);
      // See moodTool.ts: persists server-side per workspace until set_mood_tool is called
      // again, so this may be unchanged from the previous turn's mood rather than a fresh pick
      // every time — that's expected, not a bug.
      if (res.mood) setMood(res.mood);
      sounds.play("receive");
      synthesis.speak(res.result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      sounds.play("error");
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
    <div className="jarvis-shell">
      <div className="jarvis-hologram-wrap">
        <Hologram
          size={320}
          bleed={12}
          status={busy ? "PROCESSING" : recognition.listening ? "LISTENING" : "ONLINE"}
          thinking={busy}
          showThemeSelector={false}
          showReadout={false}
          assistantName={assistantName}
        />
      </div>

      <div className="jarvis-meta-row">
        <div className="jarvis-mood-badge" title={`Assistant mood: ${mood} — set by the LLM via set_mood_tool; persists until it calls that tool again.`}>
          <JarvisHologram mood={mood} size={40} hideLabel hideBars />
          <span style={{ textTransform: "capitalize" }}>{mood}</span>
        </div>

        {projects.length > 0 && (
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
            <option value="">(active project / server cwd)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}

        {modelInfo && modelInfo.models.length > 1 && (
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              // See the load effect above: this is what makes the pick survive a reload instead
              // of silently reverting to the server default every time the tab remounts.
              if (e.target.value === modelInfo.default) localStorage.removeItem("xcoder_chat_model");
              else localStorage.setItem("xcoder_chat_model", e.target.value);
            }}
            aria-label="Model"
            title={
              modelInfo.source === "fallback"
                ? "Ollama isn't reachable right now, so this is the list of models docker-compose pulls. One of these may still be downloading."
                : "Model used for this conversation"
            }
          >
            {modelInfo.models.map((m) => (
              <option key={m} value={m}>
                {m}
                {m === modelInfo.default ? " (default)" : ""}
              </option>
            ))}
          </select>
        )}

        <SpeakToggle synthesis={synthesis} />
        <SoundToggle sounds={sounds} />
      </div>

      <div className="jarvis-body">
        <div className="jarvis-thread" ref={threadRef}>
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

        {error && <div className="badge badge-red" style={{ marginBottom: 4, display: "flex" }}>{error}</div>}

        <div className="jarvis-footer">
          <InterimTranscript recognition={recognition} />
          <div className="jarvis-input-bar">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={`Speak or type a directive for ${assistantName}… (Enter to send, Shift+Enter for a new line)`}
              disabled={busy}
            />
            <VoiceButton recognition={recognition} />
            <button className="btn btn-primary jarvis-send-btn" onClick={send} disabled={busy || !input.trim()} title="Send">
              {busy ? <span className="spinner" /> : "➤"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
