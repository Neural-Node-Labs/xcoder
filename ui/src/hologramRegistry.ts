import { useEffect, useState, lazy } from "react";
import type { ComponentType } from "react";
import type { HologramProps } from "./components/holograms/types";
import { JarvisHologram } from "./components/JarvisHologram";
import { Halogram } from "./components/Halogram";

/**
 * The switchable hologram system: every selectable avatar kind, in one place. Settings lists
 * this array to build its picker and preview; ChatPanel looks up the selected id here to know
 * which component to render (wrapped in <Suspense> — see ChatPanel.tsx/SettingsPage.tsx — since
 * the six WebGL kinds below are lazy-loaded). Adding a new kind means adding one entry here;
 * neither Settings nor ChatPanel need to change.
 *
 * Every entry's Component accepts the exact same HologramProps (mood/size/label/hideLabel/
 * assistantName/thinking/listening/bleed/className/style — see components/holograms/types.ts),
 * "the property needed by xcoder chat" every kind must support, so ChatPanel can render
 * whichever is selected through nothing more than `<Component {...props} />`.
 *
 * Halogram and JarvisHologram are plain static imports — no extra dependencies, tiny, and are
 * the two most likely defaults, so there's no reason to defer them. The other six all pull in
 * `three` (a ~600KB+ dependency) — lazy (React.lazy, i.e. a dynamic import()) so that three.js
 * is only ever downloaded by someone who actually selects one of those six kinds, rather than
 * being forced into every page load's main bundle regardless of which (if any) WebGL hologram
 * is ever chosen.
 */

export type HologramStyleId = "halogram" | "jarvis" | "chaos" | "tactical" | "humanoid" | "orbital" | "mecha" | "reactor-core";

export interface HologramStyleEntry {
  id: HologramStyleId;
  label: string;
  description: string;
  Component: ComponentType<HologramProps>;
}

/** "halogram" (the PNG-face design) is first and is the default. */
export const HOLOGRAM_STYLES: HologramStyleEntry[] = [
  { id: "halogram", label: "Halogram", description: "Holographic AI face with mood-matched artwork, orbiting rings, and a particle backdrop.", Component: Halogram },
  { id: "jarvis", label: "Abstract HUD", description: "Circuit-ring hologram with a voice-bar equalizer — no image or 3D assets, pure CSS.", Component: JarvisHologram },
  {
    id: "chaos",
    label: "Neural Chaos",
    description: "A noise-distorted wireframe core (WebGL/GLSL) with a rising particle field.",
    Component: lazy(() => import("./components/holograms/HalogramChaos").then((m) => ({ default: m.HalogramChaos }))),
  },
  {
    id: "tactical",
    label: "Tactical Rings",
    description: "Concentric gyroscopic rings around a wireframe core, with a 4-point reticle.",
    Component: lazy(() => import("./components/holograms/HalogramTactical").then((m) => ({ default: m.HalogramTactical }))),
  },
  {
    id: "humanoid",
    label: "Humanoid Bust",
    description: "A wireframe humanoid head and chest with breathing, blinking, and idle sway.",
    Component: lazy(() => import("./components/holograms/HalogramHumanoid").then((m) => ({ default: m.HalogramHumanoid }))),
  },
  {
    id: "orbital",
    label: "Orbital Array",
    description: "A small wireframe solar system — mood controls how fast the planets orbit.",
    Component: lazy(() => import("./components/holograms/HalogramOrbital").then((m) => ({ default: m.HalogramOrbital }))),
  },
  {
    id: "mecha",
    label: "Mecha Interface",
    description: "A wireframe robot head with a V-crest antenna and an internal reactor core.",
    Component: lazy(() => import("./components/holograms/HalogramMecha").then((m) => ({ default: m.HalogramMecha }))),
  },
  {
    id: "reactor-core",
    label: "Reactor Core",
    description: "A denser four-ring variant with a central reactor unit and orbiting nodes.",
    Component: lazy(() => import("./components/holograms/HalogramReactorCore").then((m) => ({ default: m.HalogramReactorCore }))),
  },
];

const VALID_IDS = new Set(HOLOGRAM_STYLES.map((s) => s.id));
const DEFAULT_STYLE: HologramStyleId = "halogram";

export const HOLOGRAM_STYLE_STORAGE_KEY = "xcoder_hologram_style";
const CHANGE_EVENT = "xcoder:hologram-style-changed";

export function getStoredHologramStyle(): HologramStyleId {
  const stored = localStorage.getItem(HOLOGRAM_STYLE_STORAGE_KEY);
  return stored && VALID_IDS.has(stored as HologramStyleId) ? (stored as HologramStyleId) : DEFAULT_STYLE;
}

export function setHologramStyle(id: HologramStyleId): void {
  if (id === DEFAULT_STYLE) localStorage.removeItem(HOLOGRAM_STYLE_STORAGE_KEY);
  else localStorage.setItem(HOLOGRAM_STYLE_STORAGE_KEY, id);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Live-reactive read (same-tab CustomEvent + cross-tab `storage` event — see theme.ts/
 *  assistantName.ts for the identical pattern). */
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

export function getHologramStyleEntry(id: HologramStyleId): HologramStyleEntry {
  return HOLOGRAM_STYLES.find((s) => s.id === id) ?? HOLOGRAM_STYLES[0];
}
