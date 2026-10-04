import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

export const DAY_MS = 86_400_000;
export type ResetMode = "daily" | "rolling";

/** Marks work started by the scheduler. Only this work is stopped by the daily allowance; human chat is never blocked. */
export const autonomousCtx = new AsyncLocalStorage<{ autonomous: true }>();

export class AllowanceExhausted extends Error {
  constructor() { super("daily token allowance exhausted"); this.name = "AllowanceExhausted"; }
}

interface LedgerFile { start: number; used: number }

/**
 * Counts every token the agent spends (chat, practice, scheduled work) in the current window and
 * persists it, so a restart cannot reset the count. Window = calendar day in a fixed UTC offset, or a
 * rolling 24h that begins at the first spend after the previous window ended.
 */
export class TokenLedger {
  private s: LedgerFile = { start: 0, used: 0 };
  constructor(private file: string, private now: () => number = Date.now) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Number.isFinite(j.start) && Number.isFinite(j.used) && j.used >= 0) this.s = { start: j.start, used: j.used };
    } catch { /* first run or corrupt file: start empty */ }
  }
  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.s), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error("[ledger] save failed", e); }
  }
  /** Start of the window containing `t`, or 0 if a rolling window hasn't begun. */
  windowStart(mode: ResetMode, tzOffsetMin: number, t = this.now()): number {
    if (mode === "daily") { const off = tzOffsetMin * 60_000; return Math.floor((t + off) / DAY_MS) * DAY_MS - off; }
    return this.s.start && t < this.s.start + DAY_MS ? this.s.start : 0;
  }
  /** Reset usage if the window has ended. */
  roll(mode: ResetMode, tzOffsetMin: number) {
    const w = this.windowStart(mode, tzOffsetMin);
    if (mode === "daily" ? this.s.start !== w : w === 0 && this.s.start !== 0) { this.s = { start: mode === "daily" ? w : 0, used: 0 }; this.save(); }
  }
  /** When the allowance next refills. Rolling windows that haven't begun refill "now". */
  resumeAt(mode: ResetMode, tzOffsetMin: number): number {
    const w = this.windowStart(mode, tzOffsetMin);
    return w ? w + DAY_MS : this.now();
  }
  add(n: number, mode: ResetMode, tzOffsetMin: number) {
    if (!Number.isFinite(n) || n <= 0) return;
    this.roll(mode, tzOffsetMin);
    if (!this.s.start) this.s.start = this.now();
    this.s.used += Math.round(n);
    this.save();
  }
  used(mode: ResetMode, tzOffsetMin: number) { this.roll(mode, tzOffsetMin); return this.s.used; }
}

/** Process-wide hooks used by LlmClient. Inert until the scheduler registers itself. */
let hooks: { record(n: number): void; assertAllowed(): void } | null = null;
export const setMeterHooks = (h: typeof hooks) => { hooks = h; };
export const recordTokens = (n: number) => hooks?.record(n);
export const assertAllowance = () => { if (autonomousCtx.getStore()) hooks?.assertAllowed(); };
