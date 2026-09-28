import { useEffect, useState } from "react";

/**
 * Which hologram component renders in the Chat tab — configurable in Settings, so a visual
 * preference doesn't require a code change. Same client-side-only, live-reactive pattern as
 * theme.ts and assistantName.ts (localStorage + a same-tab CustomEvent, since the browser's
 * native `storage` event only fires in *other* tabs/windows).
 */

export const HOLOGRAM_STYLE_STORAGE_KEY = "xcoder_hologram_style";
const CHANGE_EVENT = "xcoder:hologram-style-changed";

export type HologramStyleId = "halogram" | "jarvis";

export interface HologramStyleOption {
  id: HologramStyleId;
  label: string;
  description: string;
}

/** "halogram" (the PNG-face design) is the default. Keep in sync with the components each id
 *  actually renders — see ChatPanel.tsx's hologramStyle switch. */
export const HOLOGRAM_STYLES: HologramStyleOption[] = [
  {
    id: "halogram",
    label: "Halogram",
    description: "Holographic AI face with mood-matched artwork, orbiting rings, and a particle backdrop.",
  },
  {
    id: "jarvis",
    label: "Jarvis HUD",
    description: "Abstract circuit-ring hologram with a voice-bar equalizer — no image assets, pure CSS.",
  },
];

const VALID_IDS = new Set(HOLOGRAM_STYLES.map((s) => s.id));
const DEFAULT_STYLE: HologramStyleId = "halogram";

export function getStoredHologramStyle(): HologramStyleId {
  const stored = localStorage.getItem(HOLOGRAM_STYLE_STORAGE_KEY);
  return stored && VALID_IDS.has(stored as HologramStyleId) ? (stored as HologramStyleId) : DEFAULT_STYLE;
}

export function setHologramStyle(id: HologramStyleId): void {
  if (id === DEFAULT_STYLE) localStorage.removeItem(HOLOGRAM_STYLE_STORAGE_KEY);
  else localStorage.setItem(HOLOGRAM_STYLE_STORAGE_KEY, id);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useHologramStyle(): HologramStyleId {
  const [style, setStyle] = useState(getStoredHologramStyle);
  useEffect(() => {
    const handler = () => setStyle(getStoredHologramStyle());
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);
  return style;
}
