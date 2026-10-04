import fs from "node:fs";
import path from "node:path";

export type Verdict = { kind: "allow" | "approve" | "deny"; reason: string };
interface Rule { pattern: string; reason: string }

/** Deterministic policy engine, independent of the LLM. Rules live in kernel/policy.json (read-only). */
export class Policy {
  private cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "kernel", "policy.json"), "utf8")) as
    { readOnly: string; deny: Rule[]; approve: Rule[] };

  check(tool: string, args: Record<string, any>, autonomy: number): Verdict {
    if (tool === "write_file" || tool === "read_file") {
      const p = String(args.path ?? "");
      if (!p || p.startsWith("/") || p.split("/").includes("..")) return { kind: "deny", reason: "path outside workspace" };
      return { kind: "allow", reason: "workspace file" };
    }
    if (tool === "skill_run") return autonomy === 0 ? { kind: "approve", reason: "autonomy 0" } : { kind: "allow", reason: "verified skill" };
    const cmd = String(args.cmd ?? "");
    for (const r of this.cfg.deny) if (new RegExp(r.pattern).test(cmd)) return { kind: "deny", reason: r.reason };
    for (const r of this.cfg.approve) if (new RegExp(r.pattern).test(cmd)) return { kind: "approve", reason: r.reason };
    if (autonomy === 0 && !new RegExp(this.cfg.readOnly).test(cmd)) return { kind: "approve", reason: "autonomy 0: read-only only" };
    return { kind: "allow", reason: "within sandbox policy" };
  }
}
