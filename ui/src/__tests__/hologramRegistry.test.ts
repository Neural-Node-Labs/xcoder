// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  HOLOGRAM_STYLES,
  HOLOGRAM_STYLE_STORAGE_KEY,
  getStoredHologramStyle,
  setHologramStyle,
  getHologramStyleEntry,
} from "../hologramRegistry";
import { MOOD_TO_SOURCE_KEY, ATTACK_COLOR, resolveMoodColor } from "../components/holograms/moodMapping";
import type { JarvisMood } from "../components/holograms/types";

const ALL_MOODS: JarvisMood[] = ["happy", "sad", "alert", "ready", "attack", "danger"];

describe("hologram registry", () => {
  beforeEach(() => localStorage.clear());

  it("lists 8 kinds with unique ids, each with a label, description, and component", () => {
    expect(HOLOGRAM_STYLES).toHaveLength(8);
    const ids = HOLOGRAM_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of HOLOGRAM_STYLES) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.Component).toBeTruthy();
    }
  });

  it("defaults to halogram when nothing is stored", () => {
    expect(getStoredHologramStyle()).toBe("halogram");
  });

  it("persists a non-default choice and reads it back", () => {
    setHologramStyle("humanoid");
    expect(localStorage.getItem(HOLOGRAM_STYLE_STORAGE_KEY)).toBe("humanoid");
    expect(getStoredHologramStyle()).toBe("humanoid");
  });

  it("clears the stored value when set back to the default, rather than storing a copy of it", () => {
    setHologramStyle("mecha");
    setHologramStyle("halogram");
    expect(localStorage.getItem(HOLOGRAM_STYLE_STORAGE_KEY)).toBeNull();
    expect(getStoredHologramStyle()).toBe("halogram");
  });

  it("falls back to the default when the stored id is no longer valid (e.g. a kind was removed)", () => {
    localStorage.setItem(HOLOGRAM_STYLE_STORAGE_KEY, "not-a-real-style");
    expect(getStoredHologramStyle()).toBe("halogram");
  });

  it("getHologramStyleEntry returns the matching entry, and the first entry for an unknown id", () => {
    expect(getHologramStyleEntry("orbital").id).toBe("orbital");
    expect(getHologramStyleEntry("bogus" as never).id).toBe(HOLOGRAM_STYLES[0].id);
  });

  it("no user-visible label or description contains trademarked names from the source mockups", () => {
    const text = HOLOGRAM_STYLES.map((s) => `${s.label} ${s.description}`).join(" ").toLowerCase();
    for (const banned of ["jarvis", "stark", "iron man", "gundam", "arc reactor", "mark-vii"]) {
      expect(text).not.toContain(banned);
    }
  });
});

describe("shared mood mapping for the WebGL kinds", () => {
  it("maps every app mood to a source mood key", () => {
    for (const mood of ALL_MOODS) expect(MOOD_TO_SOURCE_KEY[mood]).toBeTruthy();
  });

  it("maps ready and danger directly", () => {
    expect(MOOD_TO_SOURCE_KEY.ready).toBe("ready");
    expect(MOOD_TO_SOURCE_KEY.danger).toBe("danger");
  });

  it("attack shares danger's numeric config but overrides its color, so they still look different", () => {
    expect(MOOD_TO_SOURCE_KEY.attack).toBe(MOOD_TO_SOURCE_KEY.danger);
    const dangerRed = 0xff3b5c;
    expect(resolveMoodColor("danger", dangerRed)).toBe(dangerRed);
    expect(resolveMoodColor("attack", dangerRed)).toBe(ATTACK_COLOR);
    expect(ATTACK_COLOR).not.toBe(dangerRed);
  });

  it("leaves every other mood's color alone", () => {
    for (const mood of ALL_MOODS.filter((m) => m !== "attack")) {
      expect(resolveMoodColor(mood, 0x123456)).toBe(0x123456);
    }
  });
});
