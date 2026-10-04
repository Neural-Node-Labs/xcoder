import type { RefObject } from "react";
import type { HologramProps } from "./types";

/**
 * The chrome every Three.js-based hologram kind shares — square canvas container, vignette,
 * scanlines, the listening ping, and the status label row — so each of the six components
 * below only has to supply its distinct 3D scene, not re-implement this wrapper six times.
 */

const STYLE_TAG_ID = "halogram3d-shell-styles";

function ensureStylesInjected() {
  if (typeof document === "undefined" || document.getElementById(STYLE_TAG_ID)) return;
  const tag = document.createElement("style");
  tag.id = STYLE_TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
ensureStylesInjected();

export interface HalogramShellProps extends HologramProps {
  containerRef: RefObject<HTMLDivElement>;
  defaultLabel: string;
}

export function HalogramShell({
  mood,
  size = 220,
  label,
  hideLabel = false,
  assistantName = "Xcoder AI",
  thinking = false,
  listening = false,
  bleed = 0,
  className,
  style,
  containerRef,
  defaultLabel,
}: HalogramShellProps) {
  const statusText = hideLabel ? "" : label ?? `${assistantName} • ${defaultLabel}`;

  return (
    <div
      className={["halo3-root", className].filter(Boolean).join(" ")}
      style={{ width: size, paddingBottom: bleed, ...style }}
      role="img"
      aria-label={`${assistantName} — mood: ${mood}${thinking ? ", processing" : ""}${listening ? ", listening" : ""}${statusText ? `, status: ${statusText}` : ""}`}
    >
      <div className="halo3-stage" style={{ width: size, height: size }}>
        <div ref={containerRef} className="halo3-canvas-container" />
        <div className="halo3-scanlines" />
        <div className="halo3-vignette" />
        {listening && (
          <>
            <div className="halo3-ping halo3-ping-1" />
            <div className="halo3-ping halo3-ping-2" />
          </>
        )}
      </div>
      {statusText && <div className="halo3-label">{statusText}</div>}
    </div>
  );
}

const CSS = `
.halo3-root {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-family: "Consolas", "Courier New", monospace;
  color: #a3efff;
}

.halo3-stage {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  background: radial-gradient(ellipse at 50% 45%, #071618 0%, #020508 78%);
}

.halo3-canvas-container {
  position: absolute;
  inset: 0;
}
.halo3-canvas-container canvas {
  width: 100% !important;
  height: 100% !important;
  display: block;
}

.halo3-scanlines {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(0, 240, 255, 0.03) 0px, rgba(0, 240, 255, 0.03) 1px, transparent 2px, transparent 4px);
  opacity: 0.7;
}

.halo3-vignette {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
  background: radial-gradient(circle at 50% 50%, transparent 45%, rgba(2, 5, 8, 0.85) 92%);
}

.halo3-ping {
  position: absolute;
  inset: 6%;
  z-index: 4;
  border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  opacity: 0;
  animation: halo3-ping 1.8s ease-out infinite;
  pointer-events: none;
}
.halo3-ping-2 {
  animation-delay: 0.9s;
}

.halo3-label {
  font-size: 11px;
  letter-spacing: 0.04em;
  opacity: 0.85;
  text-align: center;
  white-space: nowrap;
}

@keyframes halo3-ping {
  0% { transform: scale(0.9); opacity: 0.7; }
  100% { transform: scale(1.08); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .halo3-root, .halo3-root * {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
  }
}
`;
