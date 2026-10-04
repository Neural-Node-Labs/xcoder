/**
 * Shared by every selectable hologram avatar (see ../../hologramRegistry.ts) — this is "the
 * property needed by xcoder chat" every kind must accept, so ChatPanel.tsx can render whichever
 * one is selected in Settings through one lookup instead of a per-component prop shape.
 */

export type JarvisMood = "happy" | "sad" | "alert" | "ready" | "attack" | "danger";

export interface HologramProps {
  mood: JarvisMood;
  /** Target width in px (each component derives its own height/aspect from this). Default 220. */
  size?: number;
  /** Override the default status text entirely. Pass "" to show none. */
  label?: string;
  hideLabel?: boolean;
  /** Who this is — used in the default label text and each component's aria-label. */
  assistantName?: string;
  /** "Actively working on something" — speeds up whatever motion each design already has,
   *  layered on top of the mood rather than replacing it. */
  thinking?: boolean;
  /** "Hearing you" — each design shows this as a neutral (non-mood-colored) signal, distinct
   *  from mood and thinking so the three never get confused with each other. */
  listening?: boolean;
  /** Extra bottom padding in px so a tightly-clipping parent doesn't crop the glow. */
  bleed?: number;
  className?: string;
  style?: React.CSSProperties;
}
