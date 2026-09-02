import { useEffect, useState } from "react";

const STORAGE_KEY = "xcoder_panel_opacity";
const DEFAULT_OPACITY = 0.5;

function readStoredOpacity(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  const parsed = raw !== null ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0.05, parsed)) : DEFAULT_OPACITY;
}

/**
 * Floating HUD widget that lets the operator dial the transparency of every
 * glass panel in the app up or down live, via the --panel-opacity CSS
 * variable that styles.css uses for all card / sidebar / topbar / console
 * backgrounds. Persisted to localStorage so it survives reloads.
 */
export function ThemeControls() {
  const [opacity, setOpacity] = useState<number>(() => readStoredOpacity());

  useEffect(() => {
    document.documentElement.style.setProperty("--panel-opacity", String(opacity));
    localStorage.setItem(STORAGE_KEY, String(opacity));
  }, [opacity]);

  return (
    <div className="theme-controls" title="Adjust hologram panel opacity">
      <span className="theme-controls-icon">◈</span>
      <span className="theme-controls-label">Opacity</span>
      <input
        type="range"
        min={0.05}
        max={1}
        step={0.05}
        value={opacity}
        onChange={(e) => setOpacity(Number(e.target.value))}
      />
      <span className="theme-controls-value">{Math.round(opacity * 100)}%</span>
    </div>
  );
}
