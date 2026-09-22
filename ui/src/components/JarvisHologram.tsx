import { useEffect, useMemo, useRef, useState } from "react";

/**
 * <JarvisHologram /> — a self-contained, mood-reactive HUD hologram avatar.
 *
 * Fully portable: the only dependency is React. All of its CSS (rings, core glow, radar sweep,
 * orbiting particles, voice-bar equalizer, keyframes) is injected once into <head> the first
 * time this component mounts anywhere on the page — there's no separate .css file to import,
 * no build-step config, no CSS variables assumed to already exist on the page (unlike, say,
 * XcoderLogo.tsx, which deliberately reads *this* app's --cyan/--bg-* theme tokens — this
 * component defines its own palette per mood instead, precisely so it can be copied into any
 * other React project and just work).
 *
 * Usage:
 *   <JarvisHologram mood="ready" />
 *   <JarvisHologram mood="danger" size={160} label="Hostile contact" />
 *
 * Moods: "happy" | "sad" | "alert" | "ready" | "attack" | "danger"
 */

export type JarvisMood = "happy" | "sad" | "alert" | "ready" | "attack" | "danger";

export interface JarvisHologramProps {
  mood: JarvisMood;
  /** Diameter in px of the hologram itself (the equalizer bars and label sit below it). Default 220. */
  size?: number;
  /** Override the mood's default status text. Pass "" to show no text at all. */
  label?: string;
  /** Hide the status text row entirely (equivalent to label=""). Default false. */
  hideLabel?: boolean;
  /** Hides the voice-bar equalizer row entirely. Useful for very compact badge-style usage. */
  hideBars?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

interface MoodProfile {
  primary: string;
  secondary: string;
  /** Seconds for one full ring rotation at rest — lower is more agitated. */
  spin: number;
  /** Seconds for one core breathing pulse cycle. */
  breathe: number;
  /** 0–1 relative brightness of the glow/core (sad is dim, danger is blinding). */
  intensity: number;
  /** How ragged the equalizer bars look: refresh interval in ms — lower = twitchier. */
  barInterval: number;
  /** Bar height ceiling, 0–1 — sad barely moves, attack/danger slam to the top. */
  barCeiling: number;
  label: string;
  /** Whole-hologram jitter shake (attack/danger). */
  shake: boolean;
  /** Outer ring hard-blinks instead of breathing smoothly (alert/danger). */
  blink: boolean;
  /** Rings droop downward and desaturate a touch (sad). */
  droop: boolean;
  /** Small warning glyph rendered over the core (attack/danger). */
  warn: boolean;
}

const MOODS: Record<JarvisMood, MoodProfile> = {
  happy: {
    primary: "#33ffb0",
    secondary: "#7dffe0",
    spin: 7,
    breathe: 1.6,
    intensity: 0.85,
    barInterval: 260,
    barCeiling: 0.75,
    label: "All systems nominal",
    shake: false,
    blink: false,
    droop: false,
    warn: false,
  },
  sad: {
    primary: "#3d7bd9",
    secondary: "#2a3f5f",
    spin: 16,
    breathe: 4.2,
    intensity: 0.4,
    barInterval: 700,
    barCeiling: 0.3,
    label: "Running below capacity",
    shake: false,
    blink: false,
    droop: true,
    warn: false,
  },
  alert: {
    primary: "#ffb020",
    secondary: "#ffd77a",
    spin: 4,
    breathe: 0.9,
    intensity: 0.95,
    barInterval: 160,
    barCeiling: 0.85,
    label: "Anomaly detected",
    shake: false,
    blink: true,
    droop: false,
    warn: false,
  },
  ready: {
    primary: "#00e6ff",
    secondary: "#7df3ff",
    spin: 9,
    breathe: 2.4,
    intensity: 0.7,
    barInterval: 340,
    barCeiling: 0.55,
    label: "Standing by",
    shake: false,
    blink: false,
    droop: false,
    warn: false,
  },
  attack: {
    primary: "#ff5a2f",
    secondary: "#ffb02f",
    spin: 1.4,
    breathe: 0.5,
    intensity: 1,
    barInterval: 90,
    barCeiling: 1,
    label: "Attack mode engaged",
    shake: true,
    blink: false,
    droop: false,
    warn: true,
  },
  danger: {
    primary: "#ff1f4a",
    secondary: "#ff0033",
    spin: 1.1,
    breathe: 0.4,
    intensity: 1,
    barInterval: 80,
    barCeiling: 1,
    label: "Danger — threat imminent",
    shake: true,
    blink: true,
    droop: false,
    warn: true,
  },
};

const BAR_COUNT = 5;
const STYLE_TAG_ID = "jarvis-hologram-styles";

/** Injected once per page load, no matter how many <JarvisHologram> instances mount. */
function ensureStylesInjected() {
  if (typeof document === "undefined" || document.getElementById(STYLE_TAG_ID)) return;
  const tag = document.createElement("style");
  tag.id = STYLE_TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

export function JarvisHologram({ mood, size = 220, label, hideLabel = false, hideBars = false, className, style }: JarvisHologramProps) {
  useEffect(ensureStylesInjected, []);

  const profile = MOODS[mood];
  const scale = size / 220;

  // Voice-bar equalizer: a plain CSS animation can't produce believable randomness, so this is
  // the one place JS drives the visuals directly — a small interval re-rolls target heights at
  // a mood-dependent cadence (fast/twitchy for attack & danger, slow/flat for sad), and a CSS
  // transition (see .jarvis-holo-bar's `transition`) eases each bar toward its new height so it
  // still reads as smooth motion rather than a jump-cut.
  const [barHeights, setBarHeights] = useState<number[]>(() => Array(BAR_COUNT).fill(0.15));
  const profileRef = useRef(profile);
  profileRef.current = profile;

  useEffect(() => {
    const tick = () => {
      const p = profileRef.current;
      setBarHeights(Array.from({ length: BAR_COUNT }, () => 0.12 + Math.random() * p.barCeiling));
    };
    tick();
    const id = setInterval(tick, profile.barInterval);
    return () => clearInterval(id);
    // Re-armed whenever the mood (and therefore its interval/ceiling) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mood]);

  const rootStyle = useMemo<React.CSSProperties>(
    () =>
      ({
        "--jh-primary": profile.primary,
        "--jh-secondary": profile.secondary,
        "--jh-spin": `${profile.spin}s`,
        "--jh-breathe": `${profile.breathe}s`,
        "--jh-intensity": profile.intensity,
        width: size,
        ...style,
      }) as React.CSSProperties,
    [profile, size, style]
  );

  const statusText = hideLabel ? "" : label ?? profile.label;

  return (
    <div
      className={["jarvis-holo-root", profile.shake ? "jarvis-holo-root--shake" : "", className].filter(Boolean).join(" ")}
      style={rootStyle}
      role="img"
      aria-label={`Hologram assistant — mood: ${mood}${statusText ? `, status: ${statusText}` : ""}`}
    >
      <div className="jarvis-holo-stage" style={{ width: 220 * scale, height: 220 * scale, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <div className="jarvis-holo-glow" />
        <div className={`jarvis-holo-ring jarvis-holo-ring-1${profile.droop ? " jarvis-holo-ring--droop" : ""}${profile.blink ? " jarvis-holo-ring--blink" : ""}`} />
        <div className={`jarvis-holo-ring jarvis-holo-ring-2${profile.droop ? " jarvis-holo-ring--droop" : ""}`} />
        <div className="jarvis-holo-ring jarvis-holo-ring-3" />
        <div className="jarvis-holo-sweep" />
        <div className="jarvis-holo-orbit">
          {Array.from({ length: 3 }).map((_, i) => (
            <span key={i} className={`jarvis-holo-particle jarvis-holo-particle-${i + 1}`} />
          ))}
        </div>
        <div className="jarvis-holo-core">
          <div className="jarvis-holo-core-inner" />
        </div>
        {profile.warn && <div className="jarvis-holo-warn">!</div>}
      </div>

      <div className="jarvis-holo-bars" style={{ width: 220 * scale, height: 28 * scale, gap: 4 * scale, display: hideBars ? "none" : "flex" }}>
        {barHeights.map((h, i) => (
          <span key={i} className="jarvis-holo-bar" style={{ height: `${Math.round(h * 100)}%`, width: 5 * scale, minHeight: 3 * scale, borderRadius: 2 * scale }} />
        ))}
      </div>

      {statusText && <div className="jarvis-holo-label">{statusText}</div>}
    </div>
  );
}

/* All measurements below are for the 220x220 base stage; the `size` prop scales the whole
   stage with a CSS transform rather than recomputing pixel values, so the ratios never drift. */
const CSS = `
.jarvis-holo-root {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-family: "SF Mono", "JetBrains Mono", "Fira Code", ui-monospace, Menlo, Consolas, monospace;
  color: var(--jh-primary);
}

.jarvis-holo-root--shake {
  animation: jarvis-holo-shake 0.34s ease-in-out infinite;
}

.jarvis-holo-stage {
  position: relative;
}

.jarvis-holo-glow {
  position: absolute;
  inset: -20px;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--jh-primary) 45%, transparent) 0%, transparent 70%);
  opacity: calc(var(--jh-intensity) * 0.9);
  filter: blur(6px);
  animation: jarvis-holo-breathe var(--jh-breathe) ease-in-out infinite;
}

.jarvis-holo-ring {
  position: absolute;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--jh-primary) 70%, transparent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--jh-primary) 55%, transparent);
}

.jarvis-holo-ring-1 {
  inset: 10px;
  border-style: dashed;
  animation: jarvis-holo-spin var(--jh-spin) linear infinite;
}

.jarvis-holo-ring-2 {
  inset: 34px;
  border-color: color-mix(in srgb, var(--jh-secondary) 65%, transparent);
  animation: jarvis-holo-spin-reverse calc(var(--jh-spin) * 0.7) linear infinite;
}

.jarvis-holo-ring-3 {
  inset: 58px;
  border-style: dotted;
  opacity: 0.8;
  animation: jarvis-holo-spin calc(var(--jh-spin) * 1.4) linear infinite;
}

.jarvis-holo-ring--droop {
  transform: translateY(4px) scaleY(0.94);
  opacity: 0.7;
}

.jarvis-holo-ring--blink {
  animation-name: jarvis-holo-spin, jarvis-holo-hard-blink;
  animation-duration: var(--jh-spin), 0.5s;
  animation-timing-function: linear, steps(1);
  animation-iteration-count: infinite, infinite;
}

.jarvis-holo-sweep {
  position: absolute;
  inset: 10px;
  border-radius: 50%;
  background: conic-gradient(from 0deg, transparent 0deg, color-mix(in srgb, var(--jh-primary) 55%, transparent) 18deg, transparent 42deg);
  animation: jarvis-holo-spin calc(var(--jh-spin) * 0.5) linear infinite;
  mix-blend-mode: screen;
  opacity: calc(0.5 + var(--jh-intensity) * 0.3);
}

.jarvis-holo-orbit {
  position: absolute;
  inset: 0;
  animation: jarvis-holo-spin calc(var(--jh-spin) * 0.8) linear infinite;
}

.jarvis-holo-particle {
  position: absolute;
  top: 6px;
  left: 50%;
  width: 5px;
  height: 5px;
  margin-left: -2.5px;
  border-radius: 50%;
  background: var(--jh-secondary);
  box-shadow: 0 0 8px var(--jh-secondary);
}

.jarvis-holo-particle-2 {
  transform: rotate(120deg) translateY(0);
  transform-origin: 110px 104px;
}

.jarvis-holo-particle-3 {
  transform: rotate(240deg) translateY(0);
  transform-origin: 110px 104px;
}

.jarvis-holo-core {
  position: absolute;
  inset: 82px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, color-mix(in srgb, var(--jh-primary) 90%, white 10%), var(--jh-secondary) 60%, transparent 100%);
  box-shadow: 0 0 24px color-mix(in srgb, var(--jh-primary) 80%, transparent), inset 0 0 14px rgba(0, 0, 0, 0.35);
  animation: jarvis-holo-breathe var(--jh-breathe) ease-in-out infinite;
}

.jarvis-holo-core-inner {
  position: absolute;
  inset: 30%;
  border-radius: 50%;
  background: radial-gradient(circle, white, var(--jh-primary) 70%, transparent 100%);
  opacity: 0.85;
}

.jarvis-holo-warn {
  position: absolute;
  top: -6px;
  right: 6px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--jh-secondary);
  color: #1a0a0a;
  font-weight: 800;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 10px color-mix(in srgb, var(--jh-secondary) 80%, transparent);
  animation: jarvis-holo-hard-blink 0.6s steps(1) infinite;
}

.jarvis-holo-bars {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 4px;
  height: 28px;
}

.jarvis-holo-bar {
  width: 5px;
  min-height: 3px;
  border-radius: 2px;
  background: linear-gradient(to top, var(--jh-primary), var(--jh-secondary));
  box-shadow: 0 0 6px color-mix(in srgb, var(--jh-primary) 60%, transparent);
  transition: height 180ms ease-out;
}

.jarvis-holo-label {
  font-size: 11px;
  letter-spacing: 0.04em;
  opacity: 0.85;
  text-align: center;
  white-space: nowrap;
}

@keyframes jarvis-holo-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes jarvis-holo-spin-reverse {
  to {
    transform: rotate(-360deg);
  }
}

@keyframes jarvis-holo-breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: calc(var(--jh-intensity) * 0.85);
  }
  50% {
    transform: scale(1.06);
    opacity: var(--jh-intensity);
  }
}

@keyframes jarvis-holo-hard-blink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0.25;
  }
}

@keyframes jarvis-holo-shake {
  0%,
  100% {
    transform: translate(0, 0);
  }
  25% {
    transform: translate(-1.5px, 1px);
  }
  50% {
    transform: translate(1.5px, -1px);
  }
  75% {
    transform: translate(-1px, -1.5px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .jarvis-holo-root,
  .jarvis-holo-root * {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
`;
