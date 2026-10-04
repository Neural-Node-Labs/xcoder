import { useEffect, useMemo, useRef, useState } from "react";
import type { HologramProps, JarvisMood } from "./holograms/types";

/**
 * <Halogram /> — a holographic AI-face avatar, ported from a static HTML mockup (see
 * ui/public/halogram/*.png for the artwork and the PR/commit that added this file for the
 * original standalone page). Selectable in Settings alongside every other hologram kind (see
 * ../hologramRegistry.ts) — they all share the exact same HologramProps contract
 * (mood/size/label/hideLabel/assistantName/thinking/listening/bleed/className/style — see
 * ./holograms/types.ts) so ChatPanel.tsx can swap between them without an if/else on props,
 * just on which component to render.
 *
 * Unlike JarvisHologram, this is NOT a single portable file: it references five PNG frames
 * under ui/public/halogram/ (loaded by URL, not inlined, so they don't bloat the JS bundle —
 * see the IMG_SRC map below). Copying this component to another project means copying that
 * folder too.
 *
 * Mood → artwork mapping: the source mockup only shipped distinct art for happy / sad / ready /
 * danger / mode (its "prostrated" frame was byte-identical to "sad", so it's dropped here as
 * redundant), five images for our six moods. The two that don't have a dedicated frame reuse
 * the closest one, distinguished by the surrounding glow/orbit color rather than the face
 * itself:
 *   - "alert"  → reuses the danger frame's artwork unchanged, with an amber glow/orbit color
 *     instead of danger's red (a hue-rotate to push the face itself toward amber was tried
 *     first — see the CSS comment above .halo-root[data-mv="alert"] — but a single hue-rotate
 *     can't selectively shift only the red accents without also dragging the face's cyan into
 *     green, so the pixels are left alone).
 *   - "attack" → uses the "mode" frame (a busier, tilted, actively-processing image) with a
 *     violet glow, matching the original mockup's own "mode" treatment.
 * This is a judgment call, not a spec — if the actual art reads wrong for either, swapping the
 * mapping below (MOOD_FRAME / MOOD_VISUAL) is the only change needed.
 */

const IMG_SRC: Record<"happy" | "sad" | "ready" | "danger" | "mode", string> = {
  happy: "/halogram/happy.png",
  sad: "/halogram/sad.png",
  ready: "/halogram/ready.png",
  danger: "/halogram/danger.png",
  mode: "/halogram/mode.png",
};

const MOOD_FRAME: Record<JarvisMood, keyof typeof IMG_SRC> = {
  happy: "happy",
  sad: "sad",
  ready: "ready",
  alert: "danger",
  attack: "mode",
  danger: "danger",
};

/** Drives color treatment (orbit rings, scanlines, frame glow) — distinct from MOOD_FRAME
 *  above because "alert" borrows danger's artwork but needs its own (amber, not red) palette. */
type MoodVisual = "default" | "sad" | "alert" | "attack" | "danger";
const MOOD_VISUAL: Record<JarvisMood, MoodVisual> = {
  happy: "default",
  sad: "sad",
  ready: "default",
  alert: "alert",
  attack: "attack",
  danger: "danger",
};

const DEFAULT_LABELS: Record<JarvisMood, string> = {
  happy: "All systems nominal",
  sad: "Running below capacity",
  alert: "Anomaly detected",
  ready: "Standing by",
  attack: "Attack mode engaged",
  danger: "Danger — threat imminent",
};

export type { JarvisMood };
/** Halogram needs nothing beyond the shared contract — kept as an alias (not a re-export of
 *  HologramProps directly) so a future Halogram-only field has somewhere to go without
 *  touching every other hologram kind. */
export type HalogramProps = HologramProps;

const STYLE_TAG_ID = "halogram-styles";
const STAGE_ASPECT = 400 / 336; // matches the source mockup's #scene { aspect-ratio: 336/400 }

function ensureStylesInjected() {
  if (typeof document === "undefined" || document.getElementById(STYLE_TAG_ID)) return;
  const tag = document.createElement("style");
  tag.id = STYLE_TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

export function Halogram({ mood, size = 220, label, hideLabel = false, assistantName = "Xcoder AI", thinking = false, listening = false, bleed = 0, className, style }: HalogramProps) {
  useEffect(ensureStylesInjected, []);

  const visual = MOOD_VISUAL[mood];
  const activeFrame = MOOD_FRAME[mood];
  const scale = size / 220;
  const stageHeight = size * STAGE_ASPECT;
  const shake = mood === "danger" || mood === "attack";
  const speedFactor = thinking ? 0.45 : 1;

  // 3D pointer-follow tilt + idle drift + shake, ported from the mockup's own rAF loop. Kept
  // fully imperative (direct style writes via refs, not React state) for the same reason the
  // original used a plain rAF loop instead of a framework: this runs every frame, and routing
  // it through setState would mean a render every frame for a purely visual transform.
  const sceneRef = useRef<HTMLDivElement>(null);
  const pointerState = useRef({ targetRX: 0, targetRY: 0, curRX: 0, curRY: 0, pointerActive: false, t: 0, shakeAmp: 0 });

  useEffect(() => {
    const main = sceneRef.current?.parentElement;
    if (!main) return;
    const state = pointerState.current;

    function updateTarget(clientX: number, clientY: number) {
      const r = main!.getBoundingClientRect();
      const nx = ((clientX - r.left) / r.width - 0.5) * 2;
      const ny = ((clientY - r.top) / r.height - 0.5) * 2;
      state.targetRY = nx * 16;
      state.targetRX = -ny * 10;
    }
    function onPointerDown(e: PointerEvent) {
      state.pointerActive = true;
      updateTarget(e.clientX, e.clientY);
    }
    function onPointerMove(e: PointerEvent) {
      if (state.pointerActive) updateTarget(e.clientX, e.clientY);
    }
    function onPointerUp() {
      state.pointerActive = false;
    }
    main.addEventListener("pointerdown", onPointerDown);
    main.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    let raf = 0;
    function frame() {
      state.t += 0.008 / speedFactor;
      if (!state.pointerActive) {
        state.targetRY = Math.sin(state.t) * 7 + Math.sin(state.t * 0.37) * 2.5;
        state.targetRX = Math.sin(state.t * 0.6 + 1) * 2.5;
      }
      const shakeTarget = shake ? 2.2 : 0;
      state.shakeAmp += (shakeTarget - state.shakeAmp) * 0.1;
      const shakeX = state.shakeAmp ? Math.sin(state.t * 40) * state.shakeAmp : 0;

      const ease = state.pointerActive ? 0.18 : 0.045;
      state.curRY += (state.targetRY - state.curRY) * ease;
      state.curRX += (state.targetRX - state.curRX) * ease;

      const breathe = 1 + Math.sin(state.t * 0.8) * 0.012;
      if (sceneRef.current) {
        sceneRef.current.style.transform = `translateX(${shakeX}px) rotateY(${state.curRY}deg) rotateX(${state.curRX}deg) scale(${breathe})`;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      main.removeEventListener("pointerdown", onPointerDown);
      main.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [shake, speedFactor]);

  const rootStyle = useMemo<React.CSSProperties>(
    () => ({ width: size, paddingBottom: bleed, ...style }) as React.CSSProperties,
    [size, bleed, style]
  );

  const statusText = hideLabel ? "" : label ?? `${assistantName} • ${DEFAULT_LABELS[mood]}`;

  return (
    <div
      className={["halo-root", className].filter(Boolean).join(" ")}
      style={rootStyle}
      data-mv={visual}
      role="img"
      aria-label={`${assistantName} — mood: ${mood}${thinking ? ", processing" : ""}${listening ? ", listening" : ""}${statusText ? `, status: ${statusText}` : ""}`}
    >
      <div className="halo-main" style={{ width: size, height: stageHeight }}>
        <div className="halo-floor" />
        <div className="halo-particles">
          <svg viewBox="0 0 260 260">
            <g className="halo-dot">
              <circle className="halo-twinkle" cx="28" cy="55" r="1.3" />
              <circle className="halo-twinkle" cx="224" cy="48" r="1.1" />
              <circle className="halo-twinkle" cx="12" cy="150" r="1.5" />
              <circle className="halo-twinkle" cx="244" cy="142" r="1.2" />
              <circle className="halo-twinkle" cx="38" cy="222" r="1.1" />
              <circle className="halo-twinkle" cx="214" cy="216" r="1.4" />
              <circle className="halo-twinkle" cx="130" cy="16" r="1.1" />
              <circle className="halo-twinkle" cx="130" cy="248" r="1.2" />
            </g>
          </svg>
        </div>
        <div className="halo-orbits" style={{ "--halo-spin-factor": speedFactor } as React.CSSProperties}>
          <svg viewBox="-260 -260 520 520">
            <circle className="halo-sun" cx="0" cy="0" r="2.4" />
            <g transform="rotate(-18) scale(1,0.32)">
              <circle className="halo-orbit-path" cx="0" cy="0" r="118" />
              <g className="halo-orbit-spin halo-orbit-spin-1">
                <circle className="halo-planet" cx="118" cy="0" r="3.2" />
              </g>
            </g>
            <g transform="rotate(12) scale(1,0.42)">
              <circle className="halo-orbit-path halo-dash" cx="0" cy="0" r="165" />
              <g className="halo-orbit-spin halo-orbit-spin-2">
                <circle className="halo-planet halo-small" cx="165" cy="0" r="2.4" />
              </g>
              <g className="halo-orbit-spin halo-orbit-spin-2b">
                <circle className="halo-planet halo-small" cx="165" cy="0" r="1.8" />
              </g>
            </g>
            <g transform="rotate(-6) scale(1,0.22)">
              <circle className="halo-orbit-path" cx="0" cy="0" r="222" />
              <g className="halo-orbit-spin halo-orbit-spin-3">
                <circle className="halo-planet" cx="222" cy="0" r="4" />
              </g>
            </g>
            <g transform="rotate(25) scale(1,0.5)">
              <circle className="halo-orbit-path halo-dash" cx="0" cy="0" r="250" />
              <g className="halo-orbit-spin halo-orbit-spin-4">
                <circle className="halo-planet halo-small" cx="250" cy="0" r="2" />
              </g>
            </g>
          </svg>
        </div>

        {listening && (
          <>
            <div className="halo-ping halo-ping-1" />
            <div className="halo-ping halo-ping-2" />
          </>
        )}

        <div className="halo-scene" ref={sceneRef}>
          {(Object.keys(IMG_SRC) as (keyof typeof IMG_SRC)[]).map((frame) => (
            <img key={frame} className={`halo-frame${frame === activeFrame ? " halo-frame-on" : ""}`} src={IMG_SRC[frame]} alt="" draggable={false} />
          ))}
        </div>

        <div className="halo-scanlines" />
        <div className="halo-vignette" />
      </div>

      {statusText && <div className="halo-label">{statusText}</div>}
    </div>
  );
}

const CSS = `
.halo-root {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-family: "Segoe UI", system-ui, sans-serif;
  color: #5be6e0;
}

.halo-main {
  position: relative;
  perspective: 1000px;
  touch-action: none;
  border-radius: 12px;
  overflow: hidden;
  background: radial-gradient(ellipse at 50% 30%, #071618 0%, #020608 74%);
}

.halo-floor {
  position: absolute;
  inset: 0;
  z-index: 0;
  background-image: linear-gradient(#07262a 1px, transparent 1px), linear-gradient(90deg, #07262a 1px, transparent 1px);
  background-size: 34px 34px;
  mask-image: radial-gradient(ellipse 52% 52% at 50% 40%, black 0%, transparent 80%);
  opacity: 0.4;
}

.halo-particles {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}
.halo-particles svg {
  width: 100%;
  height: 100%;
}
.halo-dot {
  fill: #5be6e0;
}
.halo-twinkle {
  animation: halo-tw 3.4s ease-in-out infinite;
}
.halo-twinkle:nth-child(odd) {
  animation-delay: 0.7s;
}
.halo-twinkle:nth-child(3n) {
  animation-delay: 1.5s;
}

.halo-orbits {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
}
.halo-orbits svg {
  width: min(150%, 520px);
  height: min(150%, 520px);
  overflow: visible;
  opacity: 0.85;
  transition: opacity 0.5s ease;
}
.halo-orbit-path {
  fill: none;
  stroke: #5be6e0;
  stroke-width: 0.6;
  opacity: 0.28;
}
.halo-orbit-path.halo-dash {
  stroke-dasharray: 1.2 6;
  opacity: 0.4;
}
.halo-planet {
  fill: #5be6e0;
  filter: drop-shadow(0 0 4px #5be6e0);
}
.halo-planet.halo-small {
  opacity: 0.85;
}
.halo-sun {
  fill: #5be6e0;
  opacity: 0.5;
  animation: halo-pulse 2.6s ease-in-out infinite;
}
.halo-orbit-spin {
  animation: halo-orbit-spin linear infinite;
  transform-origin: 0 0;
}
.halo-orbit-spin-1 { animation-duration: calc(14s * var(--halo-spin-factor, 1)); }
.halo-orbit-spin-2 { animation-duration: calc(21s * var(--halo-spin-factor, 1)); animation-direction: reverse; }
.halo-orbit-spin-2b { animation-duration: calc(21s * var(--halo-spin-factor, 1)); animation-direction: reverse; animation-delay: -8.75s; }
.halo-orbit-spin-3 { animation-duration: calc(32s * var(--halo-spin-factor, 1)); }
.halo-orbit-spin-4 { animation-duration: calc(40s * var(--halo-spin-factor, 1)); animation-direction: reverse; }

/* Color treatment per mood — see MOOD_VISUAL in Halogram.tsx for which mood maps to which. */
.halo-root[data-mv="danger"] .halo-orbit-path { stroke: #ff4d5e; }
.halo-root[data-mv="danger"] .halo-planet { fill: #ff4d5e; filter: drop-shadow(0 0 4px #ff4d5e); }
.halo-root[data-mv="danger"] .halo-sun { fill: #ff4d5e; }
.halo-root[data-mv="attack"] .halo-orbit-path { stroke: #8a7bff; }
.halo-root[data-mv="attack"] .halo-planet { fill: #8a7bff; filter: drop-shadow(0 0 4px #8a7bff); }
.halo-root[data-mv="attack"] .halo-sun { fill: #8a7bff; }
.halo-root[data-mv="alert"] .halo-orbit-path { stroke: #ffb020; }
.halo-root[data-mv="alert"] .halo-planet { fill: #ffb020; filter: drop-shadow(0 0 4px #ffb020); }
.halo-root[data-mv="alert"] .halo-sun { fill: #ffb020; }
.halo-root[data-mv="sad"] .halo-orbits svg { opacity: 0.5; }

.halo-ping {
  position: absolute;
  inset: 8%;
  z-index: 2;
  border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  opacity: 0;
  animation: halo-ping 1.8s ease-out infinite;
  pointer-events: none;
}
.halo-ping-2 {
  animation-delay: 0.9s;
}

.halo-scene {
  position: absolute;
  inset: 0;
  z-index: 3;
  transform-style: preserve-3d;
  will-change: transform;
}

.halo-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  object-position: center bottom;
  opacity: 0;
  transform: scale(1.03);
  filter: drop-shadow(0 0 14px rgba(91, 230, 224, 0.55)) saturate(1.05);
  transition: opacity 0.85s cubic-bezier(0.4, 0, 0.2, 1), filter 0.85s ease, transform 0.85s cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: center bottom;
  will-change: opacity, transform;
  -webkit-user-drag: none;
  user-select: none;
  pointer-events: none;
}
.halo-frame-on {
  opacity: 1;
  transform: scale(1);
  z-index: 1;
}

.halo-root[data-mv="danger"] .halo-frame-on {
  filter: drop-shadow(0 0 16px rgba(255, 77, 94, 0.7)) saturate(1.2);
}
.halo-root[data-mv="attack"] .halo-frame-on {
  filter: drop-shadow(0 0 16px rgba(138, 123, 255, 0.65)) hue-rotate(18deg) saturate(1.1);
}
/* "alert" reuses the danger frame's artwork as-is (see MOOD_FRAME) — a hue-rotate was tried to
   push it toward amber instead of red, but a single hue-rotate can't selectively shift only
   the red accents without also dragging the face's cyan into green (rotating the whole hue
   wheel uniformly), so the face itself is left untouched here. The amber distinction comes from
   everything around the face instead: the orbit rings, the glow color below, and the label
   text (see MOOD_VISUAL/.halo-root[data-mv="alert"] rules throughout this file). */
.halo-root[data-mv="alert"] .halo-frame-on {
  filter: drop-shadow(0 0 18px rgba(255, 176, 32, 0.75)) saturate(1.05);
}

.halo-scanlines {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(91, 230, 224, 0.035) 0px, rgba(91, 230, 224, 0.035) 1px, transparent 2px, transparent 4px);
  mix-blend-mode: screen;
  transition: background 0.5s ease;
}
.halo-root[data-mv="danger"] .halo-scanlines {
  background: repeating-linear-gradient(0deg, rgba(255, 77, 94, 0.07) 0px, rgba(255, 77, 94, 0.07) 1px, transparent 2px, transparent 4px);
}

.halo-vignette {
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
  background: radial-gradient(ellipse 60% 58% at 50% 42%, transparent 50%, #020608 100%);
}

.halo-label {
  font-size: 11px;
  letter-spacing: 0.04em;
  opacity: 0.85;
  text-align: center;
  white-space: nowrap;
}

@keyframes halo-tw {
  0%, 100% { opacity: 0.12; }
  50% { opacity: 0.75; }
}
@keyframes halo-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 0.7; }
}
@keyframes halo-orbit-spin {
  to { transform: rotate(360deg); }
}
@keyframes halo-ping {
  0% { transform: scale(0.9); opacity: 0.7; }
  100% { transform: scale(1.08); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .halo-root, .halo-root * {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}
`;
