/**
 * Strips an assistant reply down to something worth hearing out loud.
 *
 * Pure and dependency-free, and kept in its own module so it can be unit tested directly —
 * the rest of useSpeech.ts is React hooks wrapped around browser APIs that don't exist in a
 * test runner, but this is the part with actual logic in it and the part most likely to break.
 */

/** Hard cap on how much of a reply gets spoken. An agent reply can be thousands of characters;
 *  synthesising all of it produces several minutes of speech the user cannot skim or skip past. */
const MAX_SPOKEN_CHARS = 700;

/**
 * Strips a reply down to something worth hearing out loud.
 *
 * This is the difference between voice output being useful and being unbearable. Agent replies
 * are full of things that are fine to read and awful to listen to — fenced code blocks read
 * character by character, raw URLs spelled out, tables of markdown pipes, decorative rules. So
 * code blocks are replaced with a short spoken placeholder rather than dropped silently (the
 * listener should know code was there), and the rest is reduced to prose.
 */
export function toSpeakableText(raw: string): string {
  let text = raw;

  text = text.replace(/```[\s\S]*?```/g, " (code block omitted) ");
  text = text.replace(/`([^`]+)`/g, "$1");
  // Markdown links: keep the label, drop the URL.
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/https?:\/\/\S+/g, " (link) ");
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, " ");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/(^|\s)\*([^*]+)\*/g, "$1$2");
  text = text.replace(/^\s*[-*+]\s+/gm, ", ");
  text = text.replace(/\|/g, " ");
  text = text.replace(/\s+/g, " ").trim();

  if (text.length > MAX_SPOKEN_CHARS) {
    // Cut at a sentence boundary where there is one nearby, so it doesn't stop mid-word.
    const clipped = text.slice(0, MAX_SPOKEN_CHARS);
    const lastStop = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("! "), clipped.lastIndexOf("? "));
    text = `${lastStop > MAX_SPOKEN_CHARS * 0.5 ? clipped.slice(0, lastStop + 1) : clipped}… The rest is on screen.`;
  }

  return text;
}
