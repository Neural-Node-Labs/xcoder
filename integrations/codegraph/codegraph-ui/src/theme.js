// Mirrors whichever theme xcoder's own Settings page has chosen (see xcoder's
// ui/src/theme.ts — this app is served same-origin in an iframe there, so it shares
// localStorage with the parent page). xcoder writes one of "hologram" / "ember" / "daylight"
// to "xcoder_theme"; the only distinction that matters here is dark vs light chrome (see
// index.css's [data-theme="light"] block), so anything other than "daylight" maps to this
// app's existing dark look.
const XCODER_THEME_KEY = "xcoder_theme";

function currentDataTheme() {
  return localStorage.getItem(XCODER_THEME_KEY) === "daylight" ? "light" : null;
}

function apply() {
  const theme = currentDataTheme();
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
}

/** Applies the current theme immediately and keeps it live: a `storage` event fires in this
 *  document whenever the *parent* xcoder page (a different Window, even though same-origin)
 *  writes to localStorage — no iframe remount needed the way switching CodeGraph projects
 *  does, since this is just flipping a data-theme attribute rather than re-fetching anything. */
export function initTheme() {
  apply();
  window.addEventListener("storage", (e) => {
    if (e.key === XCODER_THEME_KEY || e.key === null) apply();
  });
}
