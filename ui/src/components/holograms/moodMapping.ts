import type { JarvisMood } from "./types";

/**
 * All six Three.js-based hologram kinds (Chaos, Tactical, Humanoid, Orbital, Mecha,
 * ReactorCore) share this exact same source-mood-key convention in their own MOOD_CONFIGS
 * objects, so this one mapping (and the one glossary below) is reused by all of them rather
 * than duplicated six times.
 *
 * Our six moods don't line up one-to-one with the source designs' six mood keys:
 *   - ready/danger match directly.
 *   - "synthesis" (creative output) is our closest match for "happy".
 *   - "melancholy" is our closest match for "sad".
 *   - "thinking" (heightened processing) is our closest match for "alert" — this is a
 *     deliberate reuse, not a collision with the unrelated `thinking` *prop* every component
 *     also accepts (see types.ts) for "actively working on something"; that prop layers a
 *     speed multiplier on top of whichever mood-config is active, it doesn't select one.
 *   - "attack" has no equivalent, so it reuses the "danger" config's numbers with a violet
 *     color override instead (ATTACK_COLOR below) — same pattern already used for the
 *     PNG-face Halogram's mood→artwork mapping.
 *   - "prostrated" (dormant/sleep) has no equivalent on our side and goes unused, same as it
 *     was already unused (a duplicate frame) in the original PNG-face mockup.
 */
export type SourceMoodKey = "ready" | "thinking" | "synthesis" | "danger" | "melancholy" | "prostrated";

export const MOOD_TO_SOURCE_KEY: Record<JarvisMood, SourceMoodKey> = {
  ready: "ready",
  alert: "thinking",
  happy: "synthesis",
  sad: "melancholy",
  danger: "danger",
  attack: "danger",
};

/** Violet, matching the "attack" treatment already established for the PNG-face Halogram and
 *  for JarvisHologram's own mood palette. Applied only when mood === "attack" (see each
 *  component's use of resolveMoodColor below) so "attack" reads distinctly from "danger" even
 *  though they share the same underlying numeric config. */
export const ATTACK_COLOR = 0x8a54ff;

/** Every source design's own MOOD_CONFIGS.danger.color, so ATTACK_COLOR can override it
 *  specifically for mood "attack" without changing what "danger" itself looks like. */
export function resolveMoodColor(mood: JarvisMood, configColor: number): number {
  return mood === "attack" ? ATTACK_COLOR : configColor;
}
