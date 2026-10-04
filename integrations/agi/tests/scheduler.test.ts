import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler, parseSchedule, DEFAULT_SCHEDULE, MIN_START_TOKENS } from "../src/scheduler";
import { recordTokens, assertAllowance, autonomousCtx, AllowanceExhausted, DAY_MS } from "../src/meter";

let dir: string; let t: number;
const MANILA = 480;
// 2026-10-04 12:00 Manila = 04:00 UTC
const at = (h: number, m = 0) => Date.UTC(2026, 9, 4, h, m);

function mk(opts: { run?: () => Promise<string>; blocked?: () => string | null } = {}) {
  return new Scheduler({ dir, now: () => t, run: opts.run ?? (async () => { recordTokens(1000); return "ok"; }), blockedReason: opts.blocked ?? (() => null) });
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-")); t = at(4); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("parseSchedule", () => {
  it("accepts a valid patch and ignores unknown keys", () => {
    expect(parseSchedule({ enabled: true, everyMinutes: 30, bogus: 1 }, DEFAULT_SCHEDULE)).toMatchObject({ enabled: true, everyMinutes: 30 });
  });
  it.each([
    [{ enabled: "yes" }], [{ everyMinutes: 1 }], [{ everyMinutes: 1.5 }], [{ dailyTokens: 5 }],
    [{ dailyTokens: 1e12 }], [{ reset: "weekly" }], [{ tzOffsetMin: 9999 }], ["str"], [null], [[1]],
  ])("rejects %j", (bad) => { expect(typeof parseSchedule(bad, DEFAULT_SCHEDULE)).toBe("string"); });
});

describe("Scheduler", () => {
  it("is off by default and never runs", async () => {
    let n = 0; const s = mk({ run: async () => { n++; return "x"; } });
    await s.tick(); expect(n).toBe(0); expect(s.status().state).toBe("off");
  });

  it("runs immediately when turned on, then waits everyMinutes", async () => {
    let n = 0; const s = mk({ run: async () => { n++; recordTokens(1000); return "done"; } });
    s.update({ enabled: true, everyMinutes: 60, dailyTokens: 100_000, tzOffsetMin: MANILA });
    await s.tick(); expect(n).toBe(1);
    expect(s.status().lastRun).toMatchObject({ outcome: "done", tokens: 1000, ok: true });
    t += 59 * 60_000; await s.tick(); expect(n).toBe(1);
    t += 2 * 60_000; await s.tick(); expect(n).toBe(2);
  });

  it("sleeps when the allowance is spent and resumes after the daily reset (Manila midnight)", async () => {
    let n = 0; const s = mk({ run: async () => { n++; recordTokens(60_000); return "big"; } });
    s.update({ enabled: true, everyMinutes: 5, dailyTokens: 100_000, reset: "daily", tzOffsetMin: MANILA });
    await s.tick(); t += 6 * 60_000; await s.tick();            // 120k spent in total
    expect(n).toBe(2);
    t += 6 * 60_000; await s.tick();                            // allowance gone: must not run
    expect(n).toBe(2);
    const st = s.status();
    expect(st.state).toBe("waiting-allowance");
    expect(st.remainingTokens).toBe(0);
    expect(st.refillsAt).toBe(at(16));                          // next Manila midnight = 16:00 UTC
    t = at(15, 59); await s.tick(); expect(n).toBe(2);
    t = at(16, 1);  await s.tick(); expect(n).toBe(3);          // refilled: runs again by itself
    expect(s.status().usedTokens).toBe(60_000);
  });

  it("raising the allowance while paused resumes immediately", async () => {
    let n = 0; const s = mk({ run: async () => { n++; recordTokens(10_000); return "x"; } });
    s.update({ enabled: true, everyMinutes: 5, dailyTokens: 10_000, tzOffsetMin: MANILA });
    await s.tick(); await s.tick(); expect(n).toBe(1);
    expect(s.status().state).toBe("waiting-allowance");
    s.update({ dailyTokens: 50_000 });
    await s.tick(); expect(n).toBe(2);
  });

  it("rolling window refills 24h after the first spend", async () => {
    const s = mk(); s.update({ enabled: true, everyMinutes: 5, dailyTokens: 10_000, reset: "rolling" });
    recordTokens(10_000);
    expect(s.remaining()).toBe(0);
    expect(s.status().refillsAt).toBe(t + DAY_MS);
    t += DAY_MS - 1; expect(s.remaining()).toBe(0);
    t += 2; expect(s.remaining()).toBe(10_000);
  });

  it("a run that exhausts the allowance mid-way is stopped, not allowed to overshoot", async () => {
    const s = mk({ run: async () => { for (let i = 0; i < 100; i++) { assertAllowance(); recordTokens(4000); } return "never"; } });
    s.update({ enabled: true, everyMinutes: 5, dailyTokens: 20_000, tzOffsetMin: MANILA });
    await s.tick();
    expect(s.status().lastRun).toMatchObject({ ok: false, outcome: expect.stringContaining("allowance") });
    expect(s.status().usedTokens).toBe(20_000);                 // stops at the first check after the cap
  });

  it("does not block human work: the allowance check only applies inside scheduler runs", () => {
    const s = mk(); s.update({ dailyTokens: 10_000 }); recordTokens(50_000);
    expect(() => assertAllowance()).not.toThrow();
    expect(() => autonomousCtx.run({ autonomous: true }, () => assertAllowance())).toThrow(AllowanceExhausted);
  });

  it("does not run while blocked (kill switch, probation) and reports why", async () => {
    let n = 0; let block: string | null = "kill switch engaged";
    const s = mk({ run: async () => { n++; return "x"; }, blocked: () => block });
    s.update({ enabled: true, dailyTokens: 100_000 });
    await s.tick(); expect(n).toBe(0);
    expect(s.status()).toMatchObject({ state: "blocked", blockedReason: "kill switch engaged" });
    block = null; t += 61_000; await s.tick(); expect(n).toBe(1);
  });

  it("a failing run is recorded with a bounded, single-line error and the loop keeps going", async () => {
    let n = 0; const s = mk({ run: async () => { n++; throw new Error("boom\n" + "x".repeat(1000)); } });
    s.update({ enabled: true, everyMinutes: 5, dailyTokens: 100_000 });
    await s.tick(); t += 6 * 60_000; await s.tick();
    expect(n).toBe(2);
    const e = s.status().lastError!; expect(e.length).toBeLessThanOrEqual(300); expect(e).not.toContain("\n");
  });

  it("never runs two cycles at once", async () => {
    let n = 0; let release!: () => void;
    const s = mk({ run: () => { n++; return new Promise<string>((r) => { release = () => r("ok"); }); } });
    s.update({ enabled: true, dailyTokens: 100_000 });
    const a = s.tick(); await s.tick(); await s.tick();
    expect(n).toBe(1); expect(s.status().state).toBe("running");
    release(); await a;
  });

  it("settings and token usage survive a restart", async () => {
    const a = mk(); a.update({ enabled: true, everyMinutes: 15, dailyTokens: 50_000, reset: "daily", tzOffsetMin: MANILA });
    await a.tick();
    const b = mk();
    expect(b.schedule).toMatchObject({ enabled: true, everyMinutes: 15, dailyTokens: 50_000 });
    expect(b.status().usedTokens).toBe(1000);
  });

  it("a corrupt state file falls back to safe defaults (disabled)", () => {
    fs.writeFileSync(path.join(dir, "schedule.json"), "{not json"); fs.writeFileSync(path.join(dir, "ledger.json"), "garbage");
    const s = mk(); expect(s.schedule.enabled).toBe(false); expect(s.status().usedTokens).toBe(0);
  });

  it("turning it off clears the pending run", async () => {
    let n = 0; const s = mk({ run: async () => { n++; return "x"; } });
    s.update({ enabled: true, dailyTokens: 100_000 }); s.update({ enabled: false });
    await s.tick(); expect(n).toBe(0); expect(s.status().nextRunAt).toBeNull();
  });

  it("MIN_START_TOKENS: will not start a cycle that cannot finish", async () => {
    let n = 0; const s = mk({ run: async () => { n++; return "x"; } });
    s.update({ enabled: true, dailyTokens: 10_000, tzOffsetMin: MANILA });
    recordTokens(10_000 - MIN_START_TOKENS + 1);
    await s.tick(); expect(n).toBe(0);
  });
});
