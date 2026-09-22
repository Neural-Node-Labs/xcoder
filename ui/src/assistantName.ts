import { useEffect, useState } from "react";

/**
 * The assistant's display name — configurable in Settings ("Assistant name" in the Theme
 * card's neighborhood) rather than hardcoded, specifically because the app used to hardcode
 * "JARVIS" in a couple of user-visible spots (the Chat tab's placeholder text, and — more
 * prominently — the default Hologram theme's on-screen label, see Hologram.tsx's "classic" and
 * "danger-red" themes, formerly named "jarvis-classic"/"jarvis-danger" with display text like
 * "J.A.R.V.I.S. CLASSIC" and "MARK XLV"). "JARVIS" and those Iron Man-specific terms are
 * trademarked/IP-protected fictional names, not xcoder's own branding, so a self-hosted
 * deployment showing them by default is a real (if usually low-stakes) legal exposure for
 * whoever runs it — hence this being configurable rather than just quietly renamed once.
 *
 * Client-side only (localStorage), like theme.ts — this is a per-browser display preference,
 * not a security- or correctness-sensitive server setting.
 */

export const ASSISTANT_NAME_STORAGE_KEY = "xcoder_assistant_name";
export const DEFAULT_ASSISTANT_NAME = "Xcoder AI";
const CHANGE_EVENT = "xcoder:assistant-name-changed";

export function getAssistantName(): string {
  const stored = localStorage.getItem(ASSISTANT_NAME_STORAGE_KEY);
  return stored && stored.trim() ? stored.trim() : DEFAULT_ASSISTANT_NAME;
}

/** Applies immediately for every mounted component using useAssistantName() (via a same-tab
 *  CustomEvent — the browser's native `storage` event only fires in *other* tabs/windows, not
 *  the one that made the change) and persists the choice. Passing the default name (or "")
 *  clears the override rather than storing it, so a later change to DEFAULT_ASSISTANT_NAME
 *  would apply retroactively instead of being masked by an explicitly-saved copy of the old
 *  default. */
export function setAssistantName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed || trimmed === DEFAULT_ASSISTANT_NAME) {
    localStorage.removeItem(ASSISTANT_NAME_STORAGE_KEY);
  } else {
    localStorage.setItem(ASSISTANT_NAME_STORAGE_KEY, trimmed);
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Reactive read: re-renders whenever the name changes, whether from this same tab (Settings
 *  page open alongside Chat) or another tab/window (native `storage` event). */
export function useAssistantName(): string {
  const [name, setName] = useState(getAssistantName);
  useEffect(() => {
    const handler = () => setName(getAssistantName());
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);
  return name;
}
