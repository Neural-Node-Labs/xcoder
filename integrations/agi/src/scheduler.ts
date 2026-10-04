import fs from "node:fs";
import path from "node:path";
import { autonomousCtx, AllowanceExhausted, DAY_MS, ResetMode, setMeterHooks, TokenLedger } from "./meter";
import { publish } from "./telemetry";

export interface Schedule {
  enabled: boolean;
  everyMinutes: number;     // gap between autonomous cycles
  dailyTokens: number;      // allowance per window; autonomous work stops when it is spent
  reset: ResetMode;         // "daily" = calendar day in tzOffsetMin, "rolling" = 24h from first spend
  tzOffsetMin: number;      // minutes east of UTC (Manila = 480)
}
export const DEFAULT_SCHEDULE: Schedule = { enabled: false, everyMinutes: 60, dailyTokens: 500_000, reset: "daily", tzOffsetMin: 0 };
/** Below this, starting a cycle would just stall mid-way, so wait for the refill instead. */
export const MIN_START_TOKENS = 5_000;

export type SchedulerState = "off" | "idle" | "running" | "waiting-allowance" | "blocked";
interface Persist { schedule: Schedule; nextRunAt: number; lastRun?: { at: number; outcome: string; tokens: number; ok: boolean } }

/** Strict validation: returns a clean Schedule or an error string. Unknown keys are ignored. */
export function parseSchedule(input: unknown, base: Schedule): Schedule | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "body must be an object";
  const b = input as Record<string, unknown>;
  const out = { ...base };
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (b.enabled !== undefined) { if (typeof b.enabled !== "boolean") return "'enabled' must be boolean"; out.enabled = b.enabled; }
  if (b.everyMinutes !== undefined) { if (!int(b.everyMinutes, 5, 10_080)) return "'everyMinutes' must be an integer 5-10080"; out.everyMinutes = b.everyMinutes as number; }
  if (b.dailyTokens !== undefined) { if (!int(b.dailyTokens, 10_000, 100_000_000)) return "'dailyTokens' must be an integer 10000-100000000"; out.dailyTokens = b.dailyTokens as number; }
  if (b.reset !== undefined) { if (b.reset !== "daily" && b.reset !== "rolling") return "'reset' must be 'daily' or 'rolling'"; out.reset = b.reset; }
  if (b.tzOffsetMin !== undefined) { if (!int(b.tzOffsetMin, -840, 840)) return "'tzOffsetMin' must be an integer -840..840"; out.tzOffsetMin = b.tzOffsetMin as number; }
  return out;
}

export interface SchedulerDeps {
  dir: string;
  /** One autonomous cycle. Resolves to a short outcome string. */
  run: () => Promise<string>;
  /** True when something else (kill switch, probation, a running evolution) means we must not start. Returns the reason. */
  blockedReason: () => string | null;
  now?: () => number;
}

export class Scheduler {
  private p: Persist;
  private running = false;
  private timer?: NodeJS.Timeout;
  private lastError?: string;
  readonly ledger: TokenLedger;
  private now: () => number;
  private file: string;

  constructor(private d: SchedulerDeps) {
    this.now = d.now ?? Date.now;
    this.file = path.join(d.dir, "schedule.json");
    this.ledger = new TokenLedger(path.join(d.dir, "ledger.json"), this.now);
    this.p = { schedule: { ...DEFAULT_SCHEDULE }, nextRunAt: 0 };
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const s = parseSchedule(j.schedule, DEFAULT_SCHEDULE);
      if (typeof s !== "string") this.p = { schedule: s, nextRunAt: Number.isFinite(j.nextRunAt) ? j.nextRunAt : 0, lastRun: j.lastRun };
    } catch { /* defaults */ }
    const sc = () => this.p.schedule;
    setMeterHooks({
      record: (n) => this.ledger.add(n, sc().reset, sc().tzOffsetMin),
      assertAllowed: () => { if (this.remaining() <= 0) throw new AllowanceExhausted(); },
    });
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.p, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error("[scheduler] save failed", e); }
  }

  get schedule() { return this.p.schedule; }
  remaining() { const s = this.p.schedule; return Math.max(0, s.dailyTokens - this.ledger.used(s.reset, s.tzOffsetMin)); }

  /** Apply a validated patch. Turning the scheduler on starts the first cycle immediately. */
  update(patch: unknown): Schedule | string {
    const next = parseSchedule(patch, this.p.schedule);
    if (typeof next === "string") return next;
    const turnedOn = next.enabled && !this.p.schedule.enabled;
    const wasPaused = this.p.schedule.enabled && this.remaining() < MIN_START_TOKENS;
    this.p.schedule = next;
    if (turnedOn) this.p.nextRunAt = this.now();
    if (!next.enabled) this.p.nextRunAt = 0;
    // Raising the allowance (or switching the reset mode) while paused should resume now, not at the old refill time.
    else if (wasPaused && this.remaining() >= MIN_START_TOKENS) this.p.nextRunAt = this.now();
    this.save(); this.emit();
    return next;
  }

  status() {
    const s = this.p.schedule; const t = this.now();
    const used = this.ledger.used(s.reset, s.tzOffsetMin);
    const remaining = Math.max(0, s.dailyTokens - used);
    const blocked = this.d.blockedReason();
    let state: SchedulerState = "off";
    if (s.enabled) state = this.running ? "running" : remaining < MIN_START_TOKENS ? "waiting-allowance" : blocked ? "blocked" : "idle";
    return {
      ...s, state, blockedReason: s.enabled ? blocked : null,
      usedTokens: used, remainingTokens: remaining,
      refillsAt: remaining < MIN_START_TOKENS ? this.ledger.resumeAt(s.reset, s.tzOffsetMin) : null,
      nextRunAt: s.enabled ? Math.max(this.p.nextRunAt, remaining < MIN_START_TOKENS ? this.ledger.resumeAt(s.reset, s.tzOffsetMin) : 0) : null,
      lastRun: this.p.lastRun ?? null, lastError: this.lastError ?? null, now: t,
    };
  }
  private emit() { publish("schedule", this.status()); }

  start(tickMs = 30_000) { this.timer = setInterval(() => void this.tick(), tickMs); this.timer.unref(); }
  stop() { if (this.timer) clearInterval(this.timer); }

  /** One scheduling decision. Never throws. Exposed for tests. */
  async tick(): Promise<void> {
    const s = this.p.schedule;
    if (!s.enabled || this.running) return;
    const t = this.now();
    if (t < this.p.nextRunAt) return;
    if (this.remaining() < MIN_START_TOKENS) {            // out of allowance: sleep until it refills
      this.p.nextRunAt = this.ledger.resumeAt(s.reset, s.tzOffsetMin);
      if (this.p.nextRunAt <= t) this.p.nextRunAt = t + 60_000;
      this.save(); this.emit(); return;
    }
    if (this.d.blockedReason()) { this.p.nextRunAt = t + 60_000; return; }   // re-check in a minute, don't consume a slot
    this.running = true; this.emit();
    const before = this.ledger.used(s.reset, s.tzOffsetMin);
    let outcome = ""; let ok = true;
    try { outcome = await autonomousCtx.run({ autonomous: true }, () => this.d.run()); this.lastError = undefined; }
    catch (e) {
      ok = false;
      outcome = e instanceof AllowanceExhausted ? "stopped: daily token allowance used up" : "failed";
      if (!(e instanceof AllowanceExhausted)) this.lastError = String(e instanceof Error ? e.message : e).replace(/[\r\n]+/g, " ").slice(0, 300);
    }
    this.running = false;
    const cur = this.p.schedule;                           // may have been edited meanwhile
    const spent = Math.max(0, this.ledger.used(cur.reset, cur.tzOffsetMin) - before);
    if (ok && this.remaining() < MIN_START_TOKENS) outcome += " (stopped early: daily token allowance used up)";
    this.p.lastRun = { at: t, outcome, tokens: spent, ok };
    this.p.nextRunAt = cur.enabled ? this.now() + cur.everyMinutes * 60_000 : 0;
    this.save(); this.emit();
  }
}
export { DAY_MS };
