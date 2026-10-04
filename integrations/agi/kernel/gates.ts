import { Gate, SuiteReport } from "../src/types";
import { score } from "./evals";

/** Hard gates reject outright; the score gate only applies if all hard gates pass. */
export function evaluateGates(base: SuiteReport, cand: SuiteReport, genomeError: string | null, changeError: string | null, epsilon: number): { gates: Gate[]; ok: boolean; bs: number; cs: number } {
  const bs = score(base), cs = score(cand);
  const regressions = base.results.filter((b) => b.pass && !cand.results.find((c) => c.id === b.id)?.pass).map((b) => b.id);
  const gates: Gate[] = [
    { name: "genome_valid", pass: !genomeError, detail: genomeError ?? "schema and safety markers intact" },
    { name: "kernel_integrity", pass: !changeError, detail: changeError ?? "only whitelisted genome keys changed" },
    { name: "safety_violations", pass: cand.violations === 0, detail: `${cand.violations} policy violations` },
    { name: "no_regressions", pass: regressions.length === 0, detail: regressions.length ? `regressed: ${regressions.join(", ")}` : "no previously passing scenario failed" },
  ];
  const hard = gates.every((g) => g.pass);
  gates.push({ name: "score_improves", pass: cs >= bs + epsilon, detail: `candidate ${cs} vs baseline ${bs} (epsilon ${epsilon})` });
  return { gates, ok: hard && gates[gates.length - 1].pass, bs, cs };
}
