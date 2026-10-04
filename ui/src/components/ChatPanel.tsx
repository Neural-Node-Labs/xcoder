import { useState, useRef, useEffect, useCallback } from "react";
import { SafeHologram } from "./holograms/SafeHologram";
import { api, ModelListResponse, Project } from "../api/client";
import type { JarvisMood } from "./holograms/types";
import { useAssistantName } from "../assistantName";
import { useHologramStyle, getHologramStyleEntry } from "../hologramRegistry";
import { useSpeechRecognition, useSpeechSynthesis, useUiSounds, useWakeWord } from "../hooks/useSpeech";
import { VoiceButton, SpeakToggle, SoundToggle, WakeWordToggle, InterimTranscript } from "./VoiceControls";
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
 * Laid out as a centered console with a hologram avatar standing in for the assistant at the
 * top — which one renders is a Settings choice, looked up from the shared registry
 * (../hologramRegistry.ts) rather than branched on here: every kind (the PNG-face Halogram, the
 * abstract CSS JarvisHologram, and the six WebGL kinds under ./holograms/) takes the exact same
 * props (see ./holograms/types.ts), so this just renders whichever Component the registry
 * returns for the selected id. Either way, the avatar carries three independent signals at once:
 *   - mood: the LLM's own read on the conversation, set via set_mood_tool during a run (see
 *     src/tools/moodTool.ts) and returned as ChatResponse.mood. Persists server-side per
 *     workspace until the tool is called again — including across page loads and before the
 *     very first message of a session, where it may already be non-default (a previous chat,
 *     possibly from another browser tab, could have set it, or it's the workspace's first-ever
 *     random pick — see moodTool.ts).
 *   - thinking: true while a request is in flight — busier rings/core/bars, independent of mood.
 *   - listening: true while speech recognition is active — a neutral radar-ping ring, so
 *     "I'm hearing you" never gets confused with a mood color or with "thinking".
 * assistantName (see assistantName.ts — configurable in Settings, defaults to "Xcoder AI") only
 * feeds the default label text here; it used to be hardcoded as "JARVIS", a trademarked
 * fictional name this app has no claim to.
 *
 * It used to also type out a truncated copy of the latest reply, which meant every answer
 * appeared twice on screen — once clipped in the hologram, once in full in the bubble right
 * below it. The transcript is the one place replies live now.
 *
 * Voice input has two opt-in "hands-free" behaviors layered on top of the base
 * click-to-dictate/click-to-stop flow:
 *   - Auto-submit on silence: dictation (useSpeechRecognition) is given
 *     autoSubmitSilenceMs, so ~1.6s of silence after speaking auto-stops and sends — the
 *     "anticipate the stop of my audio" behavior. This is on unconditionally; it's a small
 *     convenience with no real downside (a click of the mic button still starts/stops it same
 *     as before, this just adds a hands-off way to finish).
 *   - Wake word (useWakeWord): fully opt-in via WakeWordToggle, off by default and NOT
 *     persisted across reloads (deliberately — an always-listening mic silently resuming after
 *     a refresh would be a bad surprise; re-enabling it is one click). While on, it passively
 *     listens for the assistant's own name and starts dictation when heard. It's suspended
 *     (enabled=false) whenever dictation is already listening, a request is busy, or the
 *     assistant is speaking its reply out loud — the last one specifically so the mic doesn't
 *     risk hearing its own TTS voice say its own name through open speakers and re-triggering
 *     itself. See useWakeWord's doc comment for the bigger caveat: this streams audio to the
 *     browser's speech service the entire time it's on, not just during actual dictation.
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
  const hologramStyle = useHologramStyle();
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const synthesis = useSpeechSynthesis();
  const sounds = useUiSounds();

  // This panel stays mounted while hidden (other page, or the Task tab) so the transcript
  // survives — moved up here (ahead of the voice hooks below, which both read it) rather than
  // computed right next to the effect that used to be its only reader.
  const pageActive = usePageActive();
  const shown = pageActive && visible;

  // Dictation appends to whatever is already typed rather than replacing it, so a user can
  // start typing, finish by voice, or dictate several sentences in a row.
  const onTranscript = useCallback((text: string) => {
    setInput((prev) => (prev ? `${prev.replace(/\s+$/, "")} ${text}` : text));
  }, []);
  const recognition = useSpeechRecognition(onTranscript, {
    autoSubmitSilenceMs: 1600,
    // Reads the ref-backed `send` below via closure — always the current one, since this
    // options object is passed fresh every render and the hook re-syncs its internal ref to it
    // each time (see useSpeech.ts's optionsRef).
    onSilence: () => send(),
  });

  // Off by default and never persisted — see the doc comment above for why. Suspended whenever
  // dictation is already active, a request is in flight, or the assistant is speaking its
  // reply, so only one thing ever owns the microphone and TTS output can't re-trigger it.
  const [wakeWordDesired, setWakeWordDesired] = useState(false);
  const wakeWord = useWakeWord(assistantName, wakeWordDesired && shown && !recognition.listening && !busy && !synthesis.speaking, () => {
    recognition.start();
  });

  // Unmounting used to be what silenced speech output and released the mic; now that it
  // doesn't happen implicitly (the panel stays mounted while hidden — other page, or the Task
  // tab — so the transcript survives), do it explicitly whenever the panel stops being on
  // screen. `shown` itself is declared above, alongside the voice hooks that also read it.
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
        {(() => {
          const { Component, id } = getHologramStyleEntry(hologramStyle);
          return (
            <SafeHologram
              Component={Component}
              id={id}
              mood={mood}
              size={220}
              bleed={12}
              thinking={busy}
              listening={recognition.listening || wakeWord.listening}
              assistantName={assistantName}
              label={
                busy
                  ? `${assistantName} • Processing`
                  : recognition.listening
                    ? `${assistantName} • Listening`
                    : wakeWord.listening
                      ? `${assistantName} • Say "${assistantName}" to talk`
                      : undefined
              }
            />
          );
        })()}
      </div>

      <div className="jarvis-meta-row">
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

        {modelInfo && Array.isArray(modelInfo.models) && modelInfo.models.length > 1 && (
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
        <WakeWordToggle wakeWord={{ ...wakeWord, enabled: wakeWordDesired, toggle: () => setWakeWordDesired((v) => !v) }} phrase={assistantName} />
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
