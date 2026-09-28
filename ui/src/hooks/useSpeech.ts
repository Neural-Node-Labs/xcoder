import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Voice input (dictation, with optional silence-triggered auto-submit and wake-word
 * hands-free activation), voice output, and UI sound cues for the Task and Chat tabs.
 *
 * All three are built on browser APIs with no dependencies, and all three are strictly
 * optional: every hook here reports whether it's supported and degrades to a no-op when it
 * isn't. That matters because support is genuinely uneven — SpeechRecognition is Chrome/Edge
 * (and Safari, prefixed) only, with no Firefox implementation at all — so any control driven by
 * these must be hidden rather than rendered broken.
 */

// ─── Ambient types ──────────────────────────────────────────────────────────────
// The Web Speech API's recognition half is not in TypeScript's DOM lib (it never reached a
// stable spec), so the shapes actually used here are declared rather than pulling in a types
// package for one feature.

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
  length: number;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
    webkitAudioContext?: typeof AudioContext;
  }
}

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

// ─── Persisted preferences ──────────────────────────────────────────────────────

const SPEAK_KEY = "xcoder_voice_speak";
const SOUND_KEY = "xcoder_ui_sounds";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    // Storage can throw outright in private-browsing modes and sandboxed frames. A preference
    // failing to load is never worth breaking the page over.
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* preference simply won't persist */
  }
}

/** Remembered on/off toggle. Extracted because voice output and sound cues need identical
 *  persistence behaviour and there's no reason for two copies of it. */
function usePersistedFlag(key: string, fallback: boolean) {
  const [enabled, setEnabled] = useState(() => readFlag(key, fallback));
  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      writeFlag(key, next);
      return next;
    });
  }, [key]);
  return [enabled, toggle, setEnabled] as const;
}

// ─── Voice input (dictation) ────────────────────────────────────────────────────

export interface SpeechRecognitionState {
  supported: boolean;
  listening: boolean;
  /** Words recognised but not yet finalised. Shown as a live preview so the user can see the
   *  microphone is actually picking them up, rather than staring at an unchanged input box. */
  interim: string;
  error: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

export interface SpeechRecognitionOptions {
  /**
   * If set, dictation auto-stops and `onSilence` fires after this many ms with no interim or
   * final speech activity — the "anticipate the stop of my audio" auto-submit behavior. The
   * clock only starts once actual speech has been heard at least once (never fires just because
   * the user hasn't started talking yet), and resets on every subsequent interim or final
   * result, so it's genuinely "N ms of silence after speaking," not "N ms since pressing the
   * mic button." Omit (or 0) to disable — recognition then only stops when the caller calls
   * stop()/toggle(), same as before this option existed.
   */
  autoSubmitSilenceMs?: number;
  /** Called once when the silence timer fires. Recognition has already been stopped by the
   *  time this runs, so the caller just needs to act on whatever text it already accumulated
   *  via onFinalTranscript (e.g. send it) — it does not need to call stop() itself. */
  onSilence?: () => void;
}

/**
 * Dictation into a text field.
 *
 * @param onFinalTranscript called with each finalised chunk of speech. Chunks arrive as the
 *   engine commits them, so a caller appending to an existing value builds up a sentence
 *   naturally; it is never called with interim guesses.
 */
export function useSpeechRecognition(onFinalTranscript: (text: string) => void, options: SpeechRecognitionOptions = {}): SpeechRecognitionState {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Held in a ref so the long-lived recognition object always calls the current callback
  // rather than the one captured when it was constructed.
  const callbackRef = useRef(onFinalTranscript);
  callbackRef.current = onFinalTranscript;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const silenceTimerRef = useRef<number | null>(null);

  const supported = useMemo(() => recognitionCtor() !== null, []);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  // Restarts the "how long has it been quiet" clock — called on every speech event (interim
  // or final), so it only ever fires after a genuine gap, never mid-sentence.
  const armSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    const ms = optionsRef.current.autoSubmitSilenceMs;
    if (!ms) return;
    silenceTimerRef.current = window.setTimeout(() => {
      recognitionRef.current?.stop();
      setListening(false);
      setInterim("");
      optionsRef.current.onSilence?.();
    }, ms);
  }, [clearSilenceTimer]);

  const stop = useCallback(() => {
    clearSilenceTimer();
    recognitionRef.current?.stop();
    setListening(false);
    setInterim("");
  }, [clearSilenceTimer]);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;

    clearSilenceTimer();
    // Tear down any previous instance first — starting an already-started recognizer throws
    // an InvalidStateError, which is easy to hit by double-clicking the mic button.
    recognitionRef.current?.abort();

    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    // continuous keeps the mic open across pauses, so dictating more than one sentence doesn't
    // require pressing the button again between them.
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }
      setInterim(interimText);
      if (finalText.trim() || interimText.trim()) armSilenceTimer();
      if (finalText.trim()) callbackRef.current(finalText.trim());
    };

    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are ordinary — the user paused, or stopped deliberately.
      // Surfacing those as errors would make the control feel broken during normal use.
      if (event.error === "no-speech" || event.error === "aborted") return;
      clearSilenceTimer();
      setError(
        event.error === "not-allowed"
          ? "Microphone access was denied. Allow it in your browser's site settings to dictate."
          : `Voice input error: ${event.error}`
      );
      setListening(false);
    };

    recognition.onend = () => {
      clearSilenceTimer();
      setListening(false);
      setInterim("");
    };

    recognitionRef.current = recognition;
    setError(null);
    try {
      recognition.start();
      setListening(true);
    } catch {
      setError("Could not start voice input.");
      setListening(false);
    }
  }, [armSilenceTimer, clearSilenceTimer]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  // Release the microphone if the component unmounts mid-dictation — otherwise the browser's
  // recording indicator stays lit after navigating away from the tab.
  useEffect(() => () => {
    clearSilenceTimer();
    recognitionRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { supported, listening, interim, error, start, stop, toggle };
}

// ─── Wake word ("hands-free" activation) ─────────────────────────────────────────

export interface WakeWordState {
  supported: boolean;
  /** True while passively listening for the phrase (not the same as dictation's `listening` —
   *  a caller typically shows a shared "I'm listening" indicator for either). */
  listening: boolean;
  error: string | null;
}

/**
 * Passively listens for `phrase` and calls `onWake` when heard — the "say a phrase to start
 * dictating instead of clicking a button" half of voice input. Deliberately opt-in via
 * `enabled` (never starts itself) and always exposes `listening` so the caller can show it
 * plainly: unlike a dedicated wake-word chip, this runs full continuous speech-to-text under
 * the hood (the Web Speech API has no lighter-weight "just listen for one phrase" mode), which
 * in Chrome/Edge means the microphone is actively streaming audio to Google's speech
 * recognition service for as long as this is on — worth being visible about rather than a
 * silent background feature.
 *
 * Only one SpeechRecognition instance should ever be started at a time (see useSpeech.ts's
 * header) — so callers must set `enabled: false` while dictation (useSpeechRecognition) is
 * actively listening, and flip it back once dictation ends. ChatPanel.tsx does this by passing
 * `enabled={wakeWordDesired && !recognition.listening}`.
 *
 * @param phrase Matched case-insensitively as a substring of the final transcript (not an exact
 *   match) — "hey xcoder ai", "ok, xcoder ai please", and "xcoder ai" all match a phrase of
 *   "xcoder ai". Punctuation is stripped before comparing.
 */
export function useWakeWord(phrase: string, enabled: boolean, onWake: () => void): WakeWordState {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;
  const phraseRef = useRef(phrase);
  phraseRef.current = phrase;
  // Guards against a restart loop hammering the browser if permission was denied — one
  // "not-allowed" is enough to know retrying won't help until the user changes that setting.
  const deniedRef = useRef(false);

  const supported = useMemo(() => recognitionCtor() !== null, []);

  useEffect(() => {
    if (!enabled || !supported || deniedRef.current) {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      setListening(false);
      return;
    }

    let cancelled = false;

    function launch() {
      if (cancelled) return;
      const Ctor = recognitionCtor();
      if (!Ctor) return;

      const recognition = new Ctor();
      recognition.lang = navigator.language || "en-US";
      recognition.continuous = true;
      // Only final results are checked — cheaper, and a wake phrase doesn't need live interim
      // feedback the way dictation does.
      recognition.interimResults = false;

      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (!result.isFinal) continue;
          const normalized = result[0].transcript.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
          const target = phraseRef.current.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
          if (target && normalized.includes(target)) {
            onWakeRef.current();
            return;
          }
        }
      };

      recognition.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") return;
        if (event.error === "not-allowed") {
          deniedRef.current = true;
          setError("Microphone access was denied. Allow it in your browser's site settings to use the wake word.");
          setListening(false);
          return;
        }
        // Anything else (network hiccups are common on a long-lived connection) — let onend's
        // restart handle it rather than surfacing every transient blip as a visible error.
      };

      recognition.onend = () => {
        setListening(false);
        // The engine ends this on its own periodically even with continuous=true (long-lived
        // network speech connections are not guaranteed forever) — restart automatically for
        // as long as this is still meant to be on, so "wake word" actually means always-on
        // rather than "on until the next unrelated hiccup."
        if (!cancelled && enabled && !deniedRef.current) launch();
      };

      recognitionRef.current = recognition;
      try {
        recognition.start();
        setListening(true);
        setError(null);
      } catch {
        setListening(false);
      }
    }

    launch();

    return () => {
      cancelled = true;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, [enabled, supported]);

  return { supported, listening, error };
}

// ─── Voice output (speech synthesis) ────────────────────────────────────────────

// The text-sanitising logic lives in its own dependency-free module so it can be unit tested
// without a DOM — see speakableText.ts. Re-exported here so existing importers are unaffected.
export { toSpeakableText } from "./speakableText";
import { toSpeakableText } from "./speakableText";

export interface SpeechSynthesisState {
  supported: boolean;
  /** Whether the user wants replies read aloud. Persisted across sessions. */
  enabled: boolean;
  speaking: boolean;
  toggleEnabled: () => void;
  /** Speaks the text if voice output is on. Cancels anything already being spoken first. */
  speak: (text: string) => void;
  cancel: () => void;
}

export function useSpeechSynthesis(): SpeechSynthesisState {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  // Off by default: audio that starts on its own is intrusive, and a browser tab that suddenly
  // begins talking is worse than one that stays quiet until asked.
  const [enabled, toggleEnabled] = usePersistedFlag(SPEAK_KEY, false);
  const [speaking, setSpeaking] = useState(false);

  const cancel = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  const speak = useCallback(
    (text: string) => {
      if (!supported || !enabled) return;
      const spoken = toSpeakableText(text);
      if (!spoken) return;

      // Replacing rather than queueing: if a new reply has arrived, the previous one is stale.
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(spoken);
      utterance.lang = navigator.language || "en-US";
      utterance.rate = 1.05;
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      setSpeaking(true);
      window.speechSynthesis.speak(utterance);
    },
    [supported, enabled]
  );

  // Turning voice output off should stop the current utterance immediately, not let it finish.
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  // Leaving the tab must not leave a disembodied voice running — speechSynthesis is global to
  // the page and survives component unmount otherwise.
  useEffect(() => cancel, [cancel]);

  return { supported, enabled, speaking, toggleEnabled, speak, cancel };
}

// ─── UI sound cues ──────────────────────────────────────────────────────────────

type Cue = "send" | "receive" | "error";

/** Short tone pairs, in Hz, with duration in seconds. Synthesised rather than shipped as audio
 *  files: three cues as .mp3 assets would add weight to the bundle and a licensing question,
 *  for sounds that are two sine tones each. Rising = sent, settling = received, low = error. */
const CUES: Record<Cue, { freq: number[]; duration: number; gain: number }> = {
  send: { freq: [660, 880], duration: 0.09, gain: 0.05 },
  receive: { freq: [880, 660], duration: 0.11, gain: 0.05 },
  error: { freq: [320, 220], duration: 0.18, gain: 0.07 },
};

export interface UiSoundsState {
  enabled: boolean;
  toggle: () => void;
  play: (cue: Cue) => void;
}

export function useUiSounds(): UiSoundsState {
  const [enabled, toggle] = usePersistedFlag(SOUND_KEY, false);
  const contextRef = useRef<AudioContext | null>(null);

  const play = useCallback(
    (cue: Cue) => {
      if (!enabled) return;
      try {
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        if (!Ctor) return;
        // Created lazily on first use rather than on mount: browsers block AudioContext
        // construction outside a user gesture, and an autoplay-policy violation logged on
        // every page load is noise. By the time a cue plays, the user has clicked something.
        if (!contextRef.current) contextRef.current = new Ctor();
        const ctx = contextRef.current;
        if (ctx.state === "suspended") void ctx.resume();

        const { freq, duration, gain } = CUES[cue];
        const now = ctx.currentTime;
        freq.forEach((f, index) => {
          const osc = ctx.createOscillator();
          const amp = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = f;
          const start = now + index * duration;
          // Ramped rather than switched, because an abrupt gain change produces an audible
          // click that sounds like a fault rather than a notification.
          amp.gain.setValueAtTime(0, start);
          amp.gain.linearRampToValueAtTime(gain, start + 0.012);
          amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
          osc.connect(amp).connect(ctx.destination);
          osc.start(start);
          osc.stop(start + duration + 0.02);
        });
      } catch {
        // A cue failing to play is never worth surfacing to the user.
      }
    },
    [enabled]
  );

  useEffect(
    () => () => {
      void contextRef.current?.close();
      contextRef.current = null;
    },
    []
  );

  return { enabled, toggle, play };
}
