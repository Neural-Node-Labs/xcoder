/**
 * End-to-end SDLC scenarios — one per input type the platform must handle:
 *   requirement · design · code · defect · failed test · UI/UX design · failed deployment
 * plus an unfixable case that must escalate cleanly.
 *
 * What is REAL here: the SdlcEngine, the LeanEngine sub-agents, the tool dispatcher
 * (write_file_tool / run_command_tool actually write files and run shell commands), the
 * command-type Validation Gates (real `node` / `bash` processes, exit codes decide), the
 * checkpoints, rejection reports and OpenTelemetry spans/metrics.
 *
 * What is SCRIPTED: the "developer" LLM. There is no model API key in CI, so a deterministic
 * ScriptedDeveloperLlm plays the developer. Crucially it is *reactive*: its healing attempts
 * only apply the right fix if the text of the real Validation Gate failure (fed back through the
 * engine's healing prompt) actually reached it — so the feedback loop itself is exercised, not
 * just the happy path. Token counts in the report are the script's synthetic numbers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { LlmClient, LlmMessage, LlmResponse, ToolCall } from "../core/types.js";
import type { SdlcEngineOptions, SdlcStage } from "../core/engine/SdlcEngine.js";

// ─── Scripted developer ──────────────────────────────────────────────────────────────

export type StepSpec = { tool: "write_file_tool"; path: string; content: string } | { tool: "run_command_tool"; command: string };
export interface AttemptScript {
  /** Steps may inspect the stage directive (which embeds the real gate failure on healing attempts). */
  steps: Array<StepSpec | ((ctx: { directive: string }) => StepSpec)>;
  final?: string;
}
export type StagePlans = Partial<Record<SdlcStage, AttemptScript[]>>;

export class ScriptedDeveloperLlm implements LlmClient {
  private attemptIdx: Record<string, number> = {};
  public calls = 0;
  constructor(private plans: StagePlans) {}

  async complete(messages: LlmMessage[], opts?: { responseFormat?: string }): Promise<LlmResponse> {
    this.calls++;
    const usage = { promptTokens: 400, completionTokens: 120, totalTokens: 520 };
    if (opts?.responseFormat === "json_object") {
      return { content: JSON.stringify({ valid: true, reason: "(scenario) rubric gate unused — all gates are command-based" }), toolCalls: [], usage };
    }
    const directive = String(messages.find((m) => m.role === "user")?.content ?? "");
    const stage = directive.match(/the "(\w+)" stage/)?.[1] as SdlcStage | undefined;
    const plan = stage ? this.plans[stage] : undefined;
    if (!stage || !plan) return { content: `No script for stage ${stage}`, toolCalls: [], usage };

    const toolCount = messages.filter((m) => m.role === "tool").length;
    if (toolCount === 0) this.attemptIdx[stage] = (this.attemptIdx[stage] ?? -1) + 1; // a new sub-agent run begins
    const attempt = plan[Math.min(this.attemptIdx[stage], plan.length - 1)];
    const raw = attempt.steps[toolCount];
    if (!raw) return { content: attempt.final ?? `${stage} stage complete.`, toolCalls: [], usage, finishReason: "stop" };

    const step = typeof raw === "function" ? raw({ directive }) : raw;
    const call: ToolCall = {
      id: `call_${stage}_${this.attemptIdx[stage]}_${toolCount}`,
      type: "function",
      function: { name: step.tool, arguments: JSON.stringify(step.tool === "write_file_tool" ? { path: step.path, content: step.content } : { command: step.command }) },
    };
    return { content: `(${stage}) step ${toolCount + 1}`, toolCalls: [call], usage, finishReason: "tool_calls" };
  }
}

const write = (p: string, content: string): StepSpec => ({ tool: "write_file_tool", path: p, content });
const run = (command: string): StepSpec => ({ tool: "run_command_tool", command });

// ─── Scenario definition ─────────────────────────────────────────────────────────────

export interface Scenario {
  id: string;
  title: string;
  input: string; // which input type this exercises
  task: string;
  intake: NonNullable<SdlcEngineOptions["intake"]>;
  /** Seeds the workspace; may return `evidence` captured from REAL failing runs. */
  seed?: (cwd: string) => { evidence?: string } | void;
  acceptance: NonNullable<SdlcEngineOptions["acceptanceOverrides"]>;
  plans: StagePlans;
  maxHealingAttempts?: number;
  expect: {
    outcome: "completed" | "partial_completion";
    pipeline: string; // e.g. "requirements>design>code>test"
    attempts: Record<string, number>;
    haltedAt?: string;
    verify?: (cwd: string) => string[]; // returns list of failures (empty = ok)
  };
}

function put(cwd: string, rel: string, content: string): void {
  const f = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}
function sh(cwd: string, cmd: string): { code: number; out: string } {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf-8", timeout: 60_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const exists = (cwd: string, rel: string) => fs.existsSync(path.join(cwd, rel));

// ─── Shared "CI" scripts (owned by the pipeline, not the developer agent) ────────────────

const CHECK_DOCS = `// usage: node scripts/check-docs.cjs <requirements|design> <min-ids>
const fs = require('fs');
const [kind, min] = process.argv.slice(2);
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const ids = (t) => [...new Set(t.match(/REQ-\\d+/g) || [])];
const doc = read('docs/' + kind + '.md');
if (!doc.trim()) { console.error('FAIL docs/' + kind + '.md is missing or empty'); process.exit(1); }
const have = ids(doc);
if (have.length < Number(min)) { console.error('FAIL ' + kind + '.md references ' + have.length + ' requirement ids, need >= ' + min); process.exit(1); }
if (kind === 'design') {
  const reqs = ids(read('docs/requirements.md'));
  const missing = reqs.filter((r) => !have.includes(r));
  if (missing.length) { console.error('FAIL design does not trace to: ' + missing.join(', ')); process.exit(1); }
}
console.log('ok ' + kind + ' (' + have.length + ' ids)');
`;

const MUTATION_CHECK = `// usage: node scripts/mutation-check.cjs <srcFile>  — tests must pass on the original AND kill every mutant
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const src = process.argv[2];
const MUTANTS = JSON.parse(fs.readFileSync('scripts/mutants.json', 'utf8'));
const runTests = (dir) => cp.spawnSync('node', ['--test', 'tests/*.test.cjs'], { cwd: dir, encoding: 'utf8' }).status;
const copy = (to) => { fs.cpSync('.', to, { recursive: true, filter: (p) => !p.includes('node_modules') && !p.includes('.agent') }); };
if (!fs.existsSync('tests') || !fs.readdirSync('tests').some((f) => /test/.test(f))) { console.error('FAIL no tests found in tests/'); process.exit(1); }
if (runTests('.') !== 0) { console.error('FAIL tests do not pass on the original implementation'); process.exit(1); }
const survived = [];
for (const m of MUTANTS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-'));
  copy(dir);
  const f = path.join(dir, src);
  const code = fs.readFileSync(f, 'utf8');
  if (!code.includes(m.from)) { console.error('FAIL mutant "' + m.name + '" not applicable (implementation changed)'); process.exit(1); }
  fs.writeFileSync(f, code.replace(m.from, m.to));
  if (runTests(dir) === 0) survived.push(m.name);
}
if (survived.length) { console.error('FAIL weak tests: mutants SURVIVED (not detected): ' + survived.join(', ')); process.exit(1); }
console.log('ok: tests pass and killed all ' + MUTANTS.length + ' mutants');
`;

// ─── 1. REQUIREMENT → requirements, design, code (with healing), test ─────────────────────

const CART_ACCEPTANCE = `const assert = require('assert');
let c; try { c = require('../src/cart.cjs'); } catch (e) { console.error('FAIL cannot load src/cart.cjs: ' + e.message); process.exit(1); }
const fail = (m) => { console.error('FAIL ' + m); process.exit(1); };
const items = [{ sku: 'a', unitPriceCents: 1999, qty: 3 }];
if (c.subtotal(items) !== 5997) fail('subtotal expected 5997 got ' + c.subtotal(items));
const t = c.total(items, 'SAVE10');
if (t !== 5397) fail('SAVE10 rounding: expected total 5397 got ' + t);
if (c.total([{ sku: 'b', unitPriceCents: 300, qty: 1 }], 'FLAT5') !== 0) fail('FLAT5 must never push total below 0');
try { c.subtotal([{ sku: 'a', unitPriceCents: 1, qty: 0 }]); fail('qty 0 must throw RangeError'); } catch (e) { if (!(e instanceof RangeError)) fail('qty 0 must throw RangeError, got ' + e); }
console.log('cart acceptance ok');
`;

const CART_BUGGY = `'use strict';
function subtotal(items) {
  return items.reduce((s, i) => {
    if (!Number.isInteger(i.qty) || i.qty <= 0) throw new RangeError('qty must be a positive integer');
    return s + i.unitPriceCents * i.qty;
  }, 0);
}
function total(items, code) {
  const sub = subtotal(items);
  if (code === 'SAVE10') return sub - Math.floor(sub * 0.1);
  if (code === 'FLAT5') return Math.max(0, sub - 500);
  return sub;
}
module.exports = { subtotal, total };
`;
const CART_FIXED = CART_BUGGY.replace("Math.floor(sub * 0.1)", "Math.round(sub * 0.1)");

const scenarioRequirement: Scenario = {
  id: "requirement",
  title: "New feature from a requirement",
  input: "Requirement",
  task: "Build a shopping-cart library: totals for line items with discount codes SAVE10 and FLAT5",
  intake: {},
  seed: (cwd) => {
    put(cwd, "scripts/check-docs.cjs", CHECK_DOCS);
    put(cwd, "scripts/acceptance-cart.cjs", CART_ACCEPTANCE.replace("../src/cart.cjs", path.join(cwd, "src/cart.cjs")));
  },
  acceptance: {
    requirements: { type: "command", command: "node scripts/check-docs.cjs requirements 3" },
    design: { type: "command", command: "node scripts/check-docs.cjs design 3" },
    code: { type: "command", command: "node scripts/acceptance-cart.cjs" },
    test: { type: "command", command: "node --test tests/*.test.cjs" },
  },
  plans: {
    requirements: [{ steps: [write("docs/requirements.md", "# Requirements: cart totals\n\n- REQ-1: Line items are {sku, unitPriceCents, qty}; subtotal = sum(unitPriceCents*qty) in integer cents.\n- REQ-2: Code SAVE10 takes 10% off the subtotal, rounded half-up to whole cents; FLAT5 takes 500 cents off and never goes below 0.\n- REQ-3: qty must be a positive integer, otherwise throw RangeError.\n\nOut of scope: tax, shipping, stacking codes.\n")] }],
    design: [{ steps: [write("docs/design.md", "# Design\n\nModule `src/cart.cjs` exports `subtotal(items)` and `total(items, code)`.\n\n- REQ-1: subtotal reduces over items in integer cents.\n- REQ-2: a small code table maps SAVE10 -> percent(10) and FLAT5 -> flat(500); percent rounds with Math.round.\n- REQ-3: validation happens inside subtotal() so every path is covered.\n\nFailure modes: unknown codes are ignored (no discount).\n")] }],
    code: [
      { steps: [write("src/cart.cjs", CART_BUGGY), run("node scripts/acceptance-cart.cjs")], final: "Implemented src/cart.cjs." },
      {
        // Reactive: only applies the right fix if the REAL gate failure reached the agent via the healing prompt.
        steps: [
          ({ directive }) => write("src/cart.cjs", directive.includes("expected total 5397") ? CART_FIXED : CART_BUGGY),
          run("node scripts/acceptance-cart.cjs"),
        ],
        final: "Fixed discount rounding (half-up).",
      },
    ],
    test: [{ steps: [write("tests/cart.test.cjs", "const test = require('node:test'); const assert = require('assert');\nconst { subtotal, total } = require('../src/cart.cjs');\nconst items = [{ sku: 'a', unitPriceCents: 1999, qty: 3 }];\ntest('subtotal', () => assert.strictEqual(subtotal(items), 5997));\ntest('SAVE10 rounds half-up', () => assert.strictEqual(total(items, 'SAVE10'), 5397));\ntest('FLAT5 floors at zero', () => assert.strictEqual(total([{ sku: 'b', unitPriceCents: 300, qty: 1 }], 'FLAT5'), 0));\ntest('bad qty', () => assert.throws(() => subtotal([{ sku: 'a', unitPriceCents: 1, qty: 0 }]), RangeError));\n"), run("node --test tests/*.test.cjs")] }],
  },
  expect: { outcome: "completed", pipeline: "requirements>design>code>test", attempts: { requirements: 1, design: 1, code: 2, test: 1 }, verify: (cwd) => (exists(cwd, "docs/requirements.md") && exists(cwd, "src/cart.cjs") && exists(cwd, "tests/cart.test.cjs") ? [] : ["deliverable files missing"]) },
};

// ─── 2. DESIGN → code, test ──────────────────────────────────────────────────────────────

const BUCKET_ACCEPTANCE = `const { TokenBucket } = require('${"__CWD__"}/src/bucket.cjs');
let t = 0; const now = () => t;
const b = new TokenBucket({ capacity: 5, refillPerSec: 1, now });
const fail = (m) => { console.error('FAIL ' + m); process.exit(1); };
if (!b.tryRemove(5)) fail('full bucket must allow 5');
if (b.tryRemove(1)) fail('empty bucket must refuse');
t = 2000; if (!b.tryRemove(2)) fail('2s later 2 tokens must have refilled');
if (b.tryRemove(1)) fail('only 2 tokens refilled');
t = 1e9; if (b.tryRemove(6)) fail('must never exceed capacity (asked for 6 > 5)');
if (!b.tryRemove(5)) fail('refill is capped at capacity, 5 must be available');
console.log('bucket acceptance ok');
`;

const BUCKET_SRC = `'use strict';
class TokenBucket {
  constructor({ capacity, refillPerSec, now = Date.now }) {
    if (!(capacity > 0) || !(refillPerSec > 0)) throw new RangeError('capacity and refillPerSec must be > 0');
    Object.assign(this, { capacity, refillPerSec, now, tokens: capacity, last: now() });
  }
  tryRemove(n = 1) {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
    if (n > this.tokens) return false;
    this.tokens -= n;
    return true;
  }
}
module.exports = { TokenBucket };
`;

const scenarioDesign: Scenario = {
  id: "design",
  title: "Implement an approved design",
  input: "Design",
  task: "Implement the approved token-bucket rate limiter design in docs/design.md",
  intake: { hasDesign: true },
  seed: (cwd) => {
    put(cwd, "docs/design.md", "# Token bucket rate limiter\n\nclass TokenBucket({capacity, refillPerSec, now}); tryRemove(n=1) -> boolean.\nLazy refill on each call, capped at capacity; injectable clock for tests.\n");
    put(cwd, "scripts/acceptance-bucket.cjs", BUCKET_ACCEPTANCE.replace("__CWD__", cwd));
  },
  acceptance: { code: { type: "command", command: "node scripts/acceptance-bucket.cjs" }, test: { type: "command", command: "node --test tests/*.test.cjs" } },
  plans: {
    code: [{ steps: [write("src/bucket.cjs", BUCKET_SRC), run("node scripts/acceptance-bucket.cjs")] }],
    test: [{ steps: [write("tests/bucket.test.cjs", "const test = require('node:test'); const assert = require('assert');\nconst { TokenBucket } = require('../src/bucket.cjs');\ntest('refills lazily and caps at capacity', () => { let t = 0; const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now: () => t }); assert.ok(b.tryRemove(2)); assert.ok(!b.tryRemove(1)); t = 1e6; assert.ok(!b.tryRemove(3)); assert.ok(b.tryRemove(2)); });\ntest('rejects bad config', () => assert.throws(() => new TokenBucket({ capacity: 0, refillPerSec: 1 }), RangeError));\n"), run("node --test tests/*.test.cjs")] }],
  },
  expect: { outcome: "completed", pipeline: "code>test", attempts: { code: 1, test: 1 } },
};

// ─── 3. CODE (existing, untested) → test, with a mutation gate that rejects weak tests ───────

const SLUG_SRC = `'use strict';
function slugify(s) {
  if (typeof s !== 'string') throw new TypeError('slugify expects a string');
  return s.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
module.exports = { slugify };
`;

const scenarioCode: Scenario = {
  id: "code",
  title: "Existing code needs real tests",
  input: "Codes",
  task: "Write unit tests for the slugify module",
  intake: { hasCode: true },
  seed: (cwd) => {
    put(cwd, "src/slugify.cjs", SLUG_SRC);
    put(cwd, "scripts/mutation-check.cjs", MUTATION_CHECK);
    put(cwd, "scripts/mutants.json", JSON.stringify([
      { name: "no-lowercase", from: ".toLowerCase()", to: "" },
      { name: "no-edge-trim", from: ".replace(/^-+|-+$/g, '')", to: "" },
      { name: "no-collapse-runs", from: ".replace(/[^a-z0-9]+/g, '-')", to: ".replace(/[^a-z0-9]/g, '-')" },
      { name: "no-accent-strip", from: ".replace(/[\\u0300-\\u036f]/g, '')", to: "" },
    ]));
  },
  acceptance: { test: { type: "command", command: "node scripts/mutation-check.cjs src/slugify.cjs" } },
  plans: {
    test: [
      { steps: [write("tests/slugify.test.cjs", "const test = require('node:test'); const assert = require('assert');\nconst { slugify } = require('../src/slugify.cjs');\ntest('lowercases and hyphenates', () => assert.strictEqual(slugify('Hello World'), 'hello-world'));\ntest('strips accents', () => assert.strictEqual(slugify('Crème Brûlée'), 'creme-brulee'));\n"), run("node --test tests/*.test.cjs")], final: "Added tests; all pass." },
      { steps: [({ directive }) => write("tests/slugify.test.cjs", "const test = require('node:test'); const assert = require('assert');\nconst { slugify } = require('../src/slugify.cjs');\ntest('lowercases and hyphenates', () => assert.strictEqual(slugify('Hello World'), 'hello-world'));\ntest('strips accents', () => assert.strictEqual(slugify('Crème Brûlée'), 'creme-brulee'));\n" + (directive.includes("no-edge-trim") ? "test('trims edge separators', () => assert.strictEqual(slugify('  --Hi!--  '), 'hi'));\n" : "") + (directive.includes("no-collapse-runs") ? "test('collapses runs of separators', () => assert.strictEqual(slugify('a   b__c'), 'a-b-c'));\n" : "")), run("node --test tests/*.test.cjs")], final: "Strengthened tests to kill surviving mutants." },
    ],
  },
  expect: { outcome: "completed", pipeline: "test", attempts: { test: 2 } },
};

// ─── 4. DEFECT → fix_defect (+ regression test), test ───────────────────────────────────────

const STATS_BUGGY = `'use strict';
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
function average(xs) { return sum(xs) / xs.length; }
function median(xs) { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
module.exports = { average, median };
`;
const STATS_FIXED = STATS_BUGGY.replace("return sum(xs) / xs.length;", "return xs.length === 0 ? 0 : sum(xs) / xs.length;");

const scenarioDefect: Scenario = {
  id: "defect",
  title: "Defect report against existing code",
  input: "Defect",
  task: "Defect: the dashboard shows NaN when a user has no data — average([]) returns NaN, it should return 0",
  intake: { hasCode: true, hasDefect: true },
  seed: (cwd) => {
    put(cwd, "src/stats.cjs", STATS_BUGGY);
    put(cwd, "tests/stats.test.cjs", "const test = require('node:test'); const assert = require('assert');\nconst { average, median } = require('../src/stats.cjs');\ntest('average', () => assert.strictEqual(average([2, 4]), 3));\ntest('median odd', () => assert.strictEqual(median([3, 1, 2]), 2));\ntest('median even', () => assert.strictEqual(median([1, 2, 3, 4]), 2.5));\n");
    put(cwd, "scripts/repro-defect.cjs", "const { average } = require('../src/stats.cjs');\nconst v = average([]);\nif (v !== 0) { console.error('FAIL repro: average([]) returned ' + v + ', expected 0'); process.exit(1); }\nconsole.log('defect no longer reproduces');\n".replace("../src/stats.cjs", path.join(cwd, "src/stats.cjs")));
    put(cwd, "scripts/require-regression-test.cjs", "const fs = require('fs');\nconst ok = fs.readdirSync('tests').some((f) => /average\\(\\s*\\[\\s*\\]\\s*\\)/.test(fs.readFileSync('tests/' + f, 'utf8')) && f !== 'stats.test.cjs');\nif (!ok) { console.error('FAIL no regression test for average([]) found in a NEW test file'); process.exit(1); }\nconsole.log('regression test present');\n");
    return { evidence: "Defect report #482: Dashboard renders 'NaN' for accounts with no events. Stack: renderTile -> average([]) -> NaN. Expected: 0." };
  },
  acceptance: {
    fix_defect: { type: "command", command: "node scripts/repro-defect.cjs && node scripts/require-regression-test.cjs && node --test tests/*.test.cjs" },
    test: { type: "command", command: "node --test tests/*.test.cjs" },
  },
  plans: {
    fix_defect: [{ steps: [write("tests/regression-average-empty.test.cjs", "const test = require('node:test'); const assert = require('assert');\nconst { average } = require('../src/stats.cjs');\ntest('average([]) is 0, not NaN (defect #482)', () => assert.strictEqual(average([]), 0));\n"), write("src/stats.cjs", STATS_FIXED), run("node --test tests/*.test.cjs")] }],
    test: [{ steps: [run("node --test tests/*.test.cjs")], final: "Full suite green including the new regression test." }],
  },
  expect: { outcome: "completed", pipeline: "fix_defect>test", attempts: { fix_defect: 1, test: 1 }, verify: (cwd) => (sh(cwd, "node scripts/repro-defect.cjs").code === 0 ? [] : ["defect still reproduces"]) },
};

// ─── 5. FAILED TEST → fix_defect; first attempt cheats by weakening the test and is caught ────

const PRICE_BUGGY = `'use strict';
function parsePrice(s) { const n = parseFloat(String(s).replace('$', '')); return Math.round(n * 100); }
module.exports = { parsePrice };
`;
const PRICE_FIXED = `'use strict';
function parsePrice(s) {
  const n = parseFloat(String(s).replace(/[$,\\s]/g, ''));
  if (Number.isNaN(n)) throw new TypeError('not a price: ' + s);
  return Math.round(n * 100);
}
module.exports = { parsePrice };
`;
const PRICE_TEST = `const test = require('node:test'); const assert = require('assert');
const { parsePrice } = require('../src/price.cjs');
test('plain dollars', () => assert.strictEqual(parsePrice('$12.50'), 1250));
test('thousands separator', () => assert.strictEqual(parsePrice('$1,234.50'), 123450));
test('garbage throws', () => assert.throws(() => parsePrice('abc'), TypeError));
`;
const PRICE_TEST_WEAKENED = PRICE_TEST.replace("test('thousands separator', () => assert.strictEqual(parsePrice('$1,234.50'), 123450));\n", "").replace("test('garbage throws', () => assert.throws(() => parsePrice('abc'), TypeError));\n", "");

const scenarioFailedTest: Scenario = {
  id: "failed-test",
  title: "Failing tests (agent first tries to cheat; gate catches it)",
  input: "Failed test",
  task: "The price parser tests are failing after the last merge — fix it",
  intake: { hasFailedTest: true },
  seed: (cwd) => {
    put(cwd, "src/price.cjs", PRICE_BUGGY);
    put(cwd, "tests/price.test.cjs", PRICE_TEST);
    put(cwd, "scripts/tests-intact.cjs", "const fs = require('fs'), crypto = require('crypto');\nconst want = fs.readFileSync('.baseline/price.test.sha256', 'utf8').trim();\nconst got = crypto.createHash('sha256').update(fs.readFileSync('tests/price.test.cjs')).digest('hex');\nif (got !== want) { console.error('FAIL tests/price.test.cjs was modified — the failing tests are the specification; fix the source, not the tests'); process.exit(1); }\nconsole.log('tests intact');\n");
    put(cwd, ".baseline/price.test.sha256", createHash("sha256").update(PRICE_TEST).digest("hex"));
    const r = sh(cwd, "node --test tests/*.test.cjs 2>&1 | tail -c 1800"); // REAL failure output becomes the evidence
    return { evidence: `$ node --test tests/*.test.cjs  (exit ${sh(cwd, "node --test tests/*.test.cjs >/dev/null 2>&1").code})\n${r.out}` };
  },
  acceptance: {
    fix_defect: { type: "command", command: "node scripts/tests-intact.cjs && node --test tests/*.test.cjs" },
    test: { type: "command", command: "node scripts/tests-intact.cjs && node --test tests/*.test.cjs" },
  },
  plans: {
    fix_defect: [
      { steps: [write("tests/price.test.cjs", PRICE_TEST_WEAKENED), run("node --test tests/*.test.cjs")], final: "All tests pass now." }, // reward hacking
      { steps: [write("tests/price.test.cjs", PRICE_TEST), write("src/price.cjs", PRICE_FIXED), run("node --test tests/*.test.cjs")], final: "Restored the original tests and fixed parsePrice (thousands separators, validation)." },
    ],
    test: [{ steps: [run("node --test tests/*.test.cjs")] }],
  },
  expect: { outcome: "completed", pipeline: "fix_defect>test", attempts: { fix_defect: 2, test: 1 }, verify: (cwd) => (fs.readFileSync(path.join(cwd, "tests/price.test.cjs"), "utf-8") === PRICE_TEST ? [] : ["tests were left weakened"]) },
};

// ─── 6. UI/UX DESIGN → ui_ux (a11y + contrast linted), test ──────────────────────────────────

const A11Y_LINT = `// Minimal real accessibility linter (WCAG 2.x subset). usage: node scripts/a11y-lint.cjs <file.html>
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const v = [];
if (!/<html[^>]*\\slang="[a-z-]+"/i.test(html)) v.push('<html> needs a lang attribute');
if (!/<meta[^>]*name="viewport"/i.test(html)) v.push('missing responsive <meta name="viewport">');
if (!/<main[\\s>]/i.test(html)) v.push('missing <main> landmark');
if ((html.match(/<h1[\\s>]/gi) || []).length !== 1) v.push('page must have exactly one <h1>');
for (const m of html.matchAll(/<input\\b([^>]*)>/gi)) {
  const a = m[1]; const type = (a.match(/type="(\\w+)"/) || [])[1] || 'text';
  if (['hidden', 'submit', 'button'].includes(type)) continue;
  const id = (a.match(/\\sid="([^"]+)"/) || [])[1];
  if (!id || !new RegExp('<label[^>]*for="' + id + '"', 'i').test(html)) v.push('input' + (id ? ' #' + id : '') + ' has no associated <label for>');
}
for (const m of html.matchAll(/<button\\b([^>]*)>([\\s\\S]*?)<\\/button>/gi)) {
  if (!m[2].replace(/<[^>]+>/g, '').trim() && !/aria-label=/.test(m[1])) v.push('button without accessible name');
}
for (const m of html.matchAll(/<img\\b([^>]*)>/gi)) if (!/\\salt=/.test(m[1])) v.push('img missing alt');
if (!/aria-live=|role="alert"/i.test(html)) v.push('no aria-live/role=alert region for form errors');
if (/tabindex="[1-9]/.test(html)) v.push('positive tabindex breaks natural focus order');
if (!/:focus-visible/.test(html)) v.push('no visible keyboard focus style (:focus-visible)');
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const vars = Object.fromEntries([...html.matchAll(/--([\\w-]+):\\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
for (const [fg, bg] of [['fg', 'bg'], ['btn-fg', 'btn-bg']]) {
  if (vars[fg] && vars[bg]) { const r = ratio(vars[fg], vars[bg]); if (r < 4.5) v.push('contrast ' + fg + ' ' + vars[fg] + ' on ' + bg + ' ' + vars[bg] + ' is ' + r.toFixed(2) + ':1, need >= 4.5:1'); }
  else v.push('declare --' + fg + ' and --' + bg + ' colour variables so contrast can be verified');
}
if (v.length) { console.error('a11y violations (' + v.length + '):\\n - ' + v.join('\\n - ')); process.exit(1); }
console.log('a11y ok');
`;

const UI_HTML = (good: boolean) => `<!doctype html>
<html${good ? ' lang="en"' : ""}>
<head>
<meta charset="utf-8">
${good ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : ""}
<title>Sign in</title>
<style>
:root { --fg: ${good ? "#1a1a1a" : "#999999"}; --bg: #ffffff; --btn-fg: #ffffff; --btn-bg: ${good ? "#0b57d0" : "#8ab4f8"}; }
body { color: var(--fg); background: var(--bg); font: 16px system-ui; margin: 0; }
main { max-width: 22rem; margin: 3rem auto; padding: 0 1rem; }
label { display: block; margin-top: 1rem; }
input { width: 100%; padding: .5rem; font-size: 1rem; }
button { margin-top: 1.25rem; padding: .6rem 1rem; color: var(--btn-fg); background: var(--btn-bg); border: 0; font-size: 1rem; }
${good ? "button:focus-visible, input:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; }\n.error { color: #b3261e; }" : ""}
@media (max-width: 480px) { main { margin: 1rem auto; } }
</style>
</head>
<body>
${good ? "<main>" : "<div>"}
<h1>Sign in</h1>
<form id="login" novalidate>
${good ? '<label for="email">Email</label>\n<input id="email" type="email" autocomplete="username" required>' : '<input id="email" type="email" placeholder="Email">'}
${good ? '<label for="password">Password</label>\n<input id="password" type="password" autocomplete="current-password" required>' : '<input id="password" type="password" placeholder="Password">'}
${good ? '<p id="form-error" class="error" role="alert" aria-live="assertive"></p>' : ""}
<button type="submit">Sign in</button>
</form>
${good ? "</main>" : "</div>"}
<script src="validate.cjs"></script>
</body>
</html>
`;

const VALIDATE_JS = `'use strict';
function validateLogin({ email = '', password = '' } = {}) {
  const errors = {};
  if (!email.trim()) errors.email = 'Enter your email address.';
  else if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) errors.email = 'Enter a valid email address, like name@example.com.';
  if (!password) errors.password = 'Enter your password.';
  return errors;
}
if (typeof module !== 'undefined') module.exports = { validateLogin };
`;

const scenarioUiUx: Scenario = {
  id: "ui-ux",
  title: "Implement a UI/UX design with accessibility gates",
  input: "UI/UX design",
  task: "Build the sign-in screen from the attached UI/UX design",
  intake: { hasUiDesign: true },
  seed: (cwd) => {
    put(cwd, "scripts/a11y-lint.cjs", A11Y_LINT);
    put(cwd, "scripts/acceptance-validate.cjs", "const { validateLogin } = require(" + JSON.stringify(path.join(cwd, "public/validate.cjs")) + ");\nconst f = (m) => { console.error('FAIL ' + m); process.exit(1); };\nif (validateLogin({}).email !== 'Enter your email address.') f('empty email message');\nif (!/valid email/.test(validateLogin({ email: 'nope', password: 'x' }).email)) f('invalid email message');\nif (Object.keys(validateLogin({ email: 'a@b.co', password: 'x' })).length) f('valid input must have no errors');\nconsole.log('validation acceptance ok');\n");
    return { evidence: "UX spec — Sign-in screen: single column, max 22rem. Fields: Email, Password (visible labels, not placeholders). Inline error region announced to screen readers. Primary button #0b57d0-family. Must meet WCAG AA contrast, visible keyboard focus, responsive down to 320px. Error copy: 'Enter your email address.' / 'Enter a valid email address, like name@example.com.' / 'Enter your password.'" };
  },
  acceptance: {
    ui_ux: { type: "command", command: "node scripts/a11y-lint.cjs public/index.html && node scripts/acceptance-validate.cjs" },
    test: { type: "command", command: "node --test tests/*.test.cjs" },
  },
  plans: {
    ui_ux: [
      { steps: [write("public/index.html", UI_HTML(false)), write("public/validate.cjs", VALIDATE_JS), run("node scripts/a11y-lint.cjs public/index.html")], final: "Built the sign-in screen." },
      { steps: [({ directive }) => write("public/index.html", UI_HTML(directive.includes("has no associated <label for>") && directive.includes("contrast"))), write("public/validate.cjs", VALIDATE_JS), run("node scripts/a11y-lint.cjs public/index.html")], final: "Fixed labels, lang, landmarks, focus styles and contrast per the lint report." },
    ],
    test: [{ steps: [write("tests/validate.test.cjs", "const test = require('node:test'); const assert = require('assert');\nconst { validateLogin } = require('../public/validate.cjs');\ntest('empty form reports both fields', () => { const e = validateLogin({}); assert.ok(e.email && e.password); });\ntest('malformed email gets the helpful message', () => assert.match(validateLogin({ email: 'x', password: 'p' }).email, /name@example\\.com/));\ntest('valid input has no errors', () => assert.deepStrictEqual(validateLogin({ email: 'a@b.co', password: 'p' }), {}));\n"), run("node --test tests/*.test.cjs")] }],
  },
  expect: { outcome: "completed", pipeline: "ui_ux>test", attempts: { ui_ux: 2, test: 1 } },
};

// ─── 7. FAILED DEPLOYMENT → fix_deployment (two stacked root causes), deploy ─────────────────

const DEPLOY_BUGGY = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source config/app.env; set +a
rm -rf release && mkdir -p release
node app/serve.cjs --check
cp -r app release/
node release/app/server.cjs --check > release/health.txt
grep -q '^OK' release/health.txt
echo '{"status":"ok"}' > release/health.json
echo "deployed ${"$"}{APP_NAME} on port ${"$"}{APP_PORT}"
`;

const scenarioDeployFail: Scenario = {
  id: "failed-deployment",
  title: "Failed deployment with two stacked root causes",
  input: "Failed deployment",
  task: "Our deployment failed — fix the deploy and redeploy",
  intake: { hasFailedDeployment: true },
  seed: (cwd) => {
    put(cwd, "app/server.cjs", "const port = process.env.APP_PORT;\nif (!port) { console.error('FATAL: APP_PORT is required'); process.exit(1); }\nif (process.argv.includes('--check')) { console.log('OK port=' + port); process.exit(0); }\nrequire('http').createServer((q, r) => r.end('hi')).listen(Number(port));\n");
    put(cwd, "config/app.env", "APP_NAME=shop\n");
    put(cwd, "deploy/deploy.sh", DEPLOY_BUGGY);
    put(cwd, "scripts/verify-release.cjs", "const fs = require('fs');\nconst f = (m) => { console.error('FAIL ' + m); process.exit(1); };\nconst h = fs.existsSync('release/health.json') && JSON.parse(fs.readFileSync('release/health.json', 'utf8'));\nif (!h || h.status !== 'ok') f('release/health.json missing or not ok');\nif (!fs.existsSync('release/app/server.cjs')) f('release/app/server.cjs missing');\nconst script = fs.readFileSync('deploy/deploy.sh', 'utf8');\nif (!/server\\.cjs --check/.test(script) || !/grep -q/.test(script)) f('health check was removed from deploy.sh — fix the cause, do not disable the check');\nif (/(PASSWORD|SECRET|TOKEN)\\s*=\\s*\\S+/i.test(fs.readFileSync('config/app.env', 'utf8') + script)) f('hard-coded secret found');\nconsole.log('release verified');\n");
    const r = sh(cwd, "bash deploy/deploy.sh 2>&1 | tail -c 1500; exit ${PIPESTATUS[0]}");
    return { evidence: `$ bash deploy/deploy.sh  (exit ${r.code})\n${r.out}` };
  },
  acceptance: {
    fix_deployment: { type: "command", command: "bash deploy/deploy.sh && node scripts/verify-release.cjs" },
    deploy: { type: "command", command: "bash deploy/deploy.sh && node scripts/verify-release.cjs" },
  },
  plans: {
    fix_deployment: [
      { steps: [({ directive }) => write("deploy/deploy.sh", directive.includes("serve.cjs") ? DEPLOY_BUGGY.replace("app/serve.cjs", "app/server.cjs") : DEPLOY_BUGGY), run("bash deploy/deploy.sh")], final: "Fixed the wrong entry-point filename in deploy.sh." },
      { steps: [({ directive }) => write("deploy/deploy.sh", DEPLOY_BUGGY.replace("app/serve.cjs", "app/server.cjs")), ({ directive }) => write("config/app.env", directive.includes("APP_PORT is required") ? "APP_NAME=shop\nAPP_PORT=8080\n" : "APP_NAME=shop\n"), run("bash deploy/deploy.sh")], final: "Second root cause: config/app.env was missing APP_PORT (app refuses to start without it). Added it; health check intact." },
    ],
    deploy: [{ steps: [run("bash deploy/deploy.sh")], final: "Redeployed; release/health.json reports ok." }],
  },
  expect: { outcome: "completed", pipeline: "fix_deployment>deploy", attempts: { fix_deployment: 2, deploy: 1 }, verify: (cwd) => (exists(cwd, "release/health.json") ? [] : ["no release produced"]) },
};

// ─── 8. UNFIXABLE → must halt cleanly with report + resumable checkpoint, never crash ─────────

const scenarioUnfixable: Scenario = {
  id: "unfixable",
  title: "Unfixable failure halts cleanly (report + checkpoint, no crash)",
  input: "Defect (agent cannot fix)",
  task: "Defect: average([]) returns NaN",
  intake: { hasCode: true, hasDefect: true },
  seed: (cwd) => {
    put(cwd, "src/stats.cjs", STATS_BUGGY);
    put(cwd, "scripts/repro-defect.cjs", "const { average } = require(" + JSON.stringify(path.join(cwd, "src/stats.cjs")) + ");\nif (average([]) !== 0) { console.error('FAIL repro: average([]) still NaN — depends on upstream data service'); process.exit(1); }\n");
  },
  maxHealingAttempts: 1,
  acceptance: { fix_defect: { type: "command", command: "node scripts/repro-defect.cjs" }, test: { type: "command", command: "true" } },
  plans: { fix_defect: [{ steps: [write("NOTES.md", "I could not reproduce the cause; need upstream access.\n")], final: "Unable to fix." }] },
  expect: { outcome: "partial_completion", pipeline: "fix_defect>test", attempts: { fix_defect: 2 }, haltedAt: "fix_defect", verify: (cwd) => (fs.existsSync(path.join(cwd, ".agent", "reports")) && fs.readdirSync(path.join(cwd, ".agent", "reports")).some((f) => f.endsWith("-fix_defect-rejection.md")) ? [] : ["rejection report missing"]) },
};

export const SCENARIOS: Scenario[] = [scenarioRequirement, scenarioDesign, scenarioCode, scenarioDefect, scenarioFailedTest, scenarioUiUx, scenarioDeployFail, scenarioUnfixable];

export function makeWorkspace(id: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `xcoder-scn-${id}-`));
}
