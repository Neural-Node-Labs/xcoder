import { describe, it, expect } from "vitest";
import { toSpeakableText } from "../speakableText";

/**
 * These cover the difference between voice output being useful and being unbearable. The
 * failure mode isn't a crash — it's a browser tab spending four minutes reading a fenced code
 * block out character by character while the user has no way to skip ahead.
 */

describe("toSpeakableText", () => {
  it("replaces fenced code blocks with a spoken placeholder rather than reading them", () => {
    const input = "Here is the fix:\n\n```ts\nconst x: number = 1;\nexport default x;\n```\n\nThat should do it.";
    const spoken = toSpeakableText(input);

    expect(spoken).not.toContain("const x");
    expect(spoken).not.toContain("```");
    // Announced rather than silently dropped — the listener should know code was there,
    // otherwise the spoken reply reads as if the assistant never answered the question.
    expect(spoken).toContain("code block omitted");
    expect(spoken).toContain("Here is the fix");
    expect(spoken).toContain("That should do it");
  });

  it("handles several code blocks in one reply", () => {
    const spoken = toSpeakableText("First:\n```\na\n```\nSecond:\n```\nb\n```\nDone.");
    expect(spoken).not.toContain("```");
    expect(spoken).toContain("First");
    expect(spoken).toContain("Second");
    expect(spoken).toContain("Done");
  });

  it("keeps inline code content but drops the backticks", () => {
    // Unlike a fenced block, inline code is usually a single identifier mid-sentence — dropping
    // it would make the sentence meaningless.
    expect(toSpeakableText("Call `runTask` to start.")).toBe("Call runTask to start.");
  });

  it("replaces bare URLs, which are miserable to hear spelled out", () => {
    const spoken = toSpeakableText("See https://example.com/a/very/long/path?x=1 for details.");
    expect(spoken).not.toContain("https");
    expect(spoken).toContain("(link)");
    expect(spoken).toContain("for details");
  });

  it("keeps a markdown link's label and drops its target", () => {
    expect(toSpeakableText("Read [the docs](https://example.com/docs) first.")).toBe("Read the docs first.");
  });

  it("strips heading markers and emphasis without eating the words", () => {
    expect(toSpeakableText("## Summary\n\nThis is **important** and *urgent*.")).toBe(
      "Summary This is important and urgent."
    );
  });

  it("turns list bullets into pauses instead of reading the bullet characters", () => {
    const spoken = toSpeakableText("Steps:\n- first\n- second");
    expect(spoken).not.toMatch(/(^|\s)-\s/);
    expect(spoken).toContain("first");
    expect(spoken).toContain("second");
  });

  it("removes horizontal rules and collapses the whitespace they leave behind", () => {
    const spoken = toSpeakableText("Before\n\n---\n\nAfter");
    expect(spoken).toBe("Before After");
    expect(spoken).not.toContain("  ");
  });

  it("truncates a very long reply and says so", () => {
    const long = "This is a sentence that repeats. ".repeat(80);
    const spoken = toSpeakableText(long);

    expect(spoken.length).toBeLessThan(long.length);
    // The listener has to be told the speech stopped early, otherwise a reply that ends
    // mid-thought sounds like the assistant failed rather than like it was abridged.
    expect(spoken).toContain("The rest is on screen");
  });

  it("truncates at a sentence boundary rather than mid-word where it can", () => {
    const long = `${"Alpha beta gamma delta. ".repeat(60)}`;
    const spoken = toSpeakableText(long);
    const body = spoken.replace("… The rest is on screen.", "");
    expect(body.trimEnd().endsWith(".")).toBe(true);
  });

  it("leaves a short plain reply completely untouched", () => {
    // The common case must not be mangled by any of the rules above.
    expect(toSpeakableText("Done. I updated two files.")).toBe("Done. I updated two files.");
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    // The caller uses a falsy result to skip speaking entirely — an utterance of pure
    // whitespace would otherwise leave the speaking indicator stuck on.
    expect(toSpeakableText("")).toBe("");
    expect(toSpeakableText("   \n\n  ")).toBe("");
  });

  it("does not throw on a reply that is nothing but an unterminated code fence", () => {
    // Streamed/truncated output can genuinely end mid-fence.
    expect(() => toSpeakableText("```ts\nconst x = 1;")).not.toThrow();
  });
});
