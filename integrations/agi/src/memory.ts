import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR } from "./config";
import { Sandbox } from "./sandbox";

const vec = (t: string) => { const m = new Map<string, number>(); for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) m.set(w, (m.get(w) ?? 0) + 1); return m; };
function cos(a: Map<string, number>, b: Map<string, number>) {
  let n = 0, x = 0, y = 0;
  for (const [k, v] of a) { x += v * v; const o = b.get(k); if (o) n += v * o; }
  for (const v of b.values()) y += v * v;
  return x && y ? n / Math.sqrt(x * y) : 0;
}

export interface Skill { name: string; description: string; script: string; test: string; createdAt: number; uses: number }

export class Memory {
  private ep = path.join(AGENT_DIR, "episodic.jsonl");
  private kn = path.join(AGENT_DIR, "knowledge.jsonl");
  private sk = path.join(AGENT_DIR, "skills");
  constructor() { fs.mkdirSync(this.sk, { recursive: true }); }

  private rows(f: string): any[] {
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  }
  private top(rows: any[], q: string, k: number, key: (r: any) => string) {
    const qv = vec(q);
    return rows.map((r) => ({ r, s: cos(qv, vec(key(r))) })).filter((x) => x.s > 0.1).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.r);
  }

  addEpisode(text: string, meta: object = {}) { fs.appendFileSync(this.ep, JSON.stringify({ t: Date.now(), text, ...meta }) + "\n"); }
  addFact(text: string) { fs.appendFileSync(this.kn, JSON.stringify({ t: Date.now(), text }) + "\n"); }
  episodes(n = 20): string[] { return this.rows(this.ep).slice(-n).map((r) => r.text); }

  recall(q: string, k: number) {
    return {
      episodes: this.top(this.rows(this.ep), q, k, (r) => r.text).map((r) => r.text as string),
      facts: this.top(this.rows(this.kn), q, k, (r) => r.text).map((r) => r.text as string),
      skills: this.top(this.skills(), q, 2, (s) => s.name + " " + s.description) as Skill[],
    };
  }

  skills(): Skill[] {
    return fs.readdirSync(this.sk).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(this.sk, f), "utf8")));
  }
  skill(name: string) { return this.skills().find((s) => s.name === name); }
  skillCount() { return this.skills().length; }

  /** A skill is saved only if its own test passes inside the sandbox. */
  async saveSkillVerified(sb: Sandbox, s: Partial<Skill>): Promise<{ saved: boolean; detail: string }> {
    if (!/^[a-z0-9_]{3,40}$/.test(s.name ?? "") || !s.script || !s.test) return { saved: false, detail: "invalid skill shape" };
    if (this.skill(s.name!)) return { saved: false, detail: "already exists" };
    const session = "skilltest-" + Math.random().toString(36).slice(2, 8);
    try {
      await sb.put(session, "skill.sh", s.script); await sb.put(session, "test.sh", s.test);
      const r = await sb.exec(session, "bash test.sh", 30_000);
      if (r.code !== 0) return { saved: false, detail: `test failed: ${(r.stdout + r.stderr).slice(0, 200)}` };
      fs.writeFileSync(path.join(this.sk, s.name + ".json"), JSON.stringify({ name: s.name, description: s.description ?? "", script: s.script, test: s.test, createdAt: Date.now(), uses: 0 }, null, 2));
      return { saved: true, detail: "verified" };
    } finally { await sb.reset(session).catch(() => {}); }
  }
}
