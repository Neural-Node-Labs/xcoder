import { SpeechRecognitionState, SpeechSynthesisState, UiSoundsState } from "../hooks/useSpeech";

/**
 * The mic / speaker / sound-cue controls shared by the Task and Chat tabs.
 *
 * Each button renders only when the underlying browser API is actually available — a mic button
 * that silently does nothing in Firefox (which has no SpeechRecognition implementation) is
 * worse than no mic button, because the user can't tell whether the feature is broken or their
 * microphone is.
 */

export function VoiceButton({ recognition }: { recognition: SpeechRecognitionState }) {
  if (!recognition.supported) return null;
  return (
    <button
      type="button"
      className={`btn btn-sm voice-btn${recognition.listening ? " voice-btn-active" : ""}`}
      onClick={recognition.toggle}
      title={recognition.listening ? "Stop dictating" : "Dictate with your voice"}
      aria-pressed={recognition.listening}
      aria-label={recognition.listening ? "Stop dictating" : "Dictate with your voice"}
    >
      {recognition.listening ? "◉" : "🎤"}
    </button>
  );
}

export function SpeakToggle({ synthesis }: { synthesis: SpeechSynthesisState }) {
  if (!synthesis.supported) return null;
  return (
    <button
      type="button"
      className={`btn btn-sm voice-btn${synthesis.enabled ? " voice-btn-active" : ""}`}
      onClick={synthesis.toggleEnabled}
      title={synthesis.enabled ? "Stop reading replies aloud" : "Read replies aloud"}
      aria-pressed={synthesis.enabled}
      aria-label={synthesis.enabled ? "Stop reading replies aloud" : "Read replies aloud"}
    >
      {synthesis.enabled ? "🔊" : "🔇"}
    </button>
  );
}

export function SoundToggle({ sounds }: { sounds: UiSoundsState }) {
  return (
    <button
      type="button"
      className={`btn btn-sm voice-btn${sounds.enabled ? " voice-btn-active" : ""}`}
      onClick={sounds.toggle}
      title={sounds.enabled ? "Turn off sound cues" : "Turn on sound cues"}
      aria-pressed={sounds.enabled}
      aria-label={sounds.enabled ? "Turn off sound cues" : "Turn on sound cues"}
    >
      {sounds.enabled ? "♪" : "♪̸"}
    </button>
  );
}

/** Live preview of words the recogniser has heard but not yet committed, so the user can see
 *  the mic is picking them up instead of watching an unchanged input box. */
export function InterimTranscript({ recognition }: { recognition: SpeechRecognitionState }) {
  if (!recognition.listening && !recognition.error) return null;
  if (recognition.error) {
    return <div className="badge badge-red voice-status">{recognition.error}</div>;
  }
  return (
    <div className="voice-status" aria-live="polite">
      <span className="voice-pulse" />
      {recognition.interim ? recognition.interim : "Listening…"}
    </div>
  );
}
