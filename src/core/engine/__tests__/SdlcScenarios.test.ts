import { describe, it, expect } from "vitest";
import { SCENARIOS } from "../../../test/sdlcScenarios.js";
import { runScenario } from "../../../test/runSdlcScenarios.js";

/**
 * Real-engine, real-tool, real-shell-gate end-to-end scenarios (see src/test/sdlcScenarios.ts for
 * what is real vs scripted). Each scenario's own `expect` block is the assertion set.
 */
describe("SDLC end-to-end scenarios", () => {
  for (const scn of SCENARIOS) {
    it(`${scn.input}: ${scn.title}`, async () => {
      const r = await runScenario(scn);
      expect(r.failures).toEqual([]);
      expect(r.spans.some((s) => s.name === "sdlc.run")).toBe(true);
    }, 120_000);
  }
});
