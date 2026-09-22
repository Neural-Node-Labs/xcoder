/**
 * Theme selection — Settings > Theme (SettingsPage.tsx), applied here and to the embedded
 * CodeGraph Explorer.
 *
 * xcoder's own colors are all sourced from CSS custom properties defined once in styles.css
 * (--cyan, --bg-*, --text-*, --glass*, etc — see the "Themes" block there), so switching a
 * theme here is just flipping a `data-theme` attribute on <html>; every component picks up the
 * new values automatically with no per-component changes needed.
 *
 * The embedded CodeGraph Explorer (integrations/codegraph/codegraph-ui) is a separate app
 * served same-origin in an iframe — it shares this same localStorage (same-origin), and reads
 * this exact "xcoder_theme" key itself on load and live via the `storage` event (see
 * codegraph-ui/src/theme.js) — no separate mirrored key or explicit handoff needed from this
 * side at all.
 */

export const THEME_STORAGE_KEY = "xcoder_theme";

export interface ThemeOption {
  id: string;
  label: string;
  description: string;
}

/** "hologram" is the default and deliberately has no CSS override block of its own — it's just
 *  styles.css's bare :root. Keep this list in sync with the [data-theme="…"] blocks there. */
export const THEMES: ThemeOption[] = [
  { id: "hologram", label: "Hologram", description: "Cyan HUD on deep space navy — the original xcoder look." },
  { id: "ember", label: "Ember", description: "Amber accent on the same dark backdrop." },
  { id: "daylight", label: "Daylight", description: "Light background, blue accent." },
];

const VALID_IDS = new Set(THEMES.map((t) => t.id));

export function getStoredTheme(): string {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored && VALID_IDS.has(stored) ? stored : "hologram";
}

/** Applies the theme to xcoder's own document and persists the choice. The CodeGraph Explorer
 *  iframe (if currently open) picks this up on its own via the `storage` event — see
 *  codegraph-ui/src/theme.js — so nothing else needs to react to this call. */
export function applyTheme(id: string): void {
  const theme = VALID_IDS.has(id) ? id : "hologram";
  if (theme === "hologram") {
    // No attribute for the default keeps styles.css's bare :root (no [data-theme] selector to
    // match) in effect, rather than requiring an explicit (and easy to forget to add) block.
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}
