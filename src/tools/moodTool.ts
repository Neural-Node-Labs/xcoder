/**
 * Lets the LLM set the assistant's visible "mood" — rendered client-side as the
 * <JarvisHologram> avatar (ui/src/components/JarvisHologram.tsx) — via set_mood_tool (see its
 * schema in toolSchemas.ts, dispatched in toolDispatcher.ts).
 *
 * Persistence: keyed by workspace (cwd), not by user or a chat session id, because that's the
 * only identity dispatchToolCall() already has (see its signature) — threading a userId or
 * session id through every tool call site just for this would be a much bigger change than the
 * feature warrants. In practice this means the mood is shared across everyone working in the
 * same project's workspace, which is the right scope anyway: it's "how is xcoder doing on this
 * project" rather than a private-to-one-browser-tab setting.
 *
 * The mood set here persists until set_mood_tool is called again (routes.ts reads it back with
 * getMood() after orchestrator.run() and attaches it to ChatResponse.mood — see /chat and
 * /chat/execute) — it is NOT reset at the start of every request. If the LLM never calls the
 * tool for a given workspace, getMood() picks and caches a random mood the first time it's
 * asked, rather than silently defaulting to "ready" — see the tool's own description for why
 * that matters even when the LLM does call it: a random guess beats not calling it at all.
 */

export type JarvisMood = "happy" | "sad" | "alert" | "ready" | "attack" | "danger";

export const JARVIS_MOODS: JarvisMood[] = ["happy", "sad", "alert", "ready", "attack", "danger"];

const moodByWorkspace = new Map<string, JarvisMood>();

function pickRandomMood(): JarvisMood {
  return JARVIS_MOODS[Math.floor(Math.random() * JARVIS_MOODS.length)];
}

export function isJarvisMood(value: unknown): value is JarvisMood {
  return typeof value === "string" && (JARVIS_MOODS as string[]).includes(value);
}

/** Current mood for a workspace, choosing (and caching) a random one on first access rather
 *  than defaulting to a fixed mood every workspace would otherwise start in identically. */
export function getMood(cwd: string): JarvisMood {
  let mood = moodByWorkspace.get(cwd);
  if (!mood) {
    mood = pickRandomMood();
    moodByWorkspace.set(cwd, mood);
  }
  return mood;
}

export function setMood(cwd: string, mood: JarvisMood): void {
  moodByWorkspace.set(cwd, mood);
}

/** Used by the dispatcher: validates the LLM's requested mood, falling back to a random pick
 *  (rather than rejecting the call) when it sends something outside the six known moods —
 *  matches the "guess rather than skip" guidance the tool's own description gives the LLM, for
 *  the case where it ignores that guidance anyway. */
export function runSetMoodTool(cwd: string, requestedMood: unknown, reason?: unknown): { mood: JarvisMood; wasValid: boolean; reason?: string } {
  const wasValid = isJarvisMood(requestedMood);
  const mood = wasValid ? (requestedMood as JarvisMood) : pickRandomMood();
  setMood(cwd, mood);
  return { mood, wasValid, reason: typeof reason === "string" ? reason : undefined };
}
