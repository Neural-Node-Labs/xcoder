/**
 * Runs every scenario in sdlcScenarios.ts through the real SdlcEngine with OpenTelemetry capture.
 *   npx tsx src/test/runSdlcScenarios.ts            → prints a table, writes SDLC_SCENARIO_REPORT.md
 * Exit code 1 if any scenario deviates from its expectations.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { metrics } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, PeriodicExportingMetricReader, InMemoryMetricExporter, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { SdlcEngine } from "../core/engine/SdlcEngine.js";
import { AutoIO } from "../core/io/AutoIO.js";
import { FileTelemetry } from "../telemetry/logger.js";
import { OtelTelemetry } from "../telemetry/otel.js";
import { SCENARIOS, ScriptedDeveloperLlm, makeWorkspace, type Scenario } from "./sdlcScenarios.js";

export const spanExporter = new InMemorySpanExporter();
export const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
let meterProvider: MeterProvider | undefined;

export function installInMemoryOtel(): void {
  if (meterProvider) return;
  new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] }).register();
  meterProvider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 })] });
  metrics.setGlobalMeterProvider(meterProvider);
}

export interface ScenarioResult {
  scenario: Scenario;
  cwd: string;
  outcome: string;
  pipeline: string;
  stages: Array<{ id: string; status: string; attempts: number; history: Array<{ attempt: number; outcome: string; detail: string }> }>;
  durationMs: number;
  llmCalls: number;
  spans: ReadableSpan[];
  traceId: string;
  failures: string[];
  answerHead: string;
}

export async function runScenario(scn: Scenario): Promise<ScenarioResult> {
  installInMemoryOtel();
  const cwd = makeWorkspace(scn.id);
  const seeded = scn.seed?.(cwd) ?? {};
  const llm = new ScriptedDeveloperLlm(scn.plans);
  const engine = new SdlcEngine(llm, new OtelTelemetry(new FileTelemetry(cwd)), {
    cwd,
    io: new AutoIO({ silent: true }),
    intake: { ...scn.intake, evidence: seeded.evidence ?? scn.intake.evidence },
    acceptanceOverrides: scn.acceptance,
    maxHealingAttempts: scn.maxHealingAttempts ?? 2,
    agentTimeoutMs: 60_000,
    commandTimeoutMs: 60_000,
  });

  const before = new Set(spanExporter.getFinishedSpans());
  const t0 = Date.now();
  const answer = await engine.run(scn.task);
  const durationMs = Date.now() - t0;
  const runSpan = spanExporter.getFinishedSpans().filter((s) => !before.has(s) && s.name === "sdlc.run").at(-1);
  const traceId = runSpan?.spanContext().traceId ?? "";
  const spans = spanExporter.getFinishedSpans().filter((s) => s.spanContext().traceId === traceId);
  const dag = engine.getDag();

  const failures: string[] = [];
  const outcome = engine.getLastOutcome();
  const pipeline = dag.map((n) => n.id).join(">");
  if (outcome !== scn.expect.outcome) failures.push(`outcome ${outcome} ≠ ${scn.expect.outcome}`);
  if (pipeline !== scn.expect.pipeline) failures.push(`pipeline ${pipeline} ≠ ${scn.expect.pipeline}`);
  for (const [stage, n] of Object.entries(scn.expect.attempts)) {
    const got = dag.find((d) => d.id === stage)?.attempts;
    if (got !== n) failures.push(`${stage} attempts ${got} ≠ ${n}`);
  }
  if (scn.expect.haltedAt && dag.find((d) => d.status === "escalated")?.id !== scn.expect.haltedAt) failures.push(`did not halt at ${scn.expect.haltedAt}`);
  failures.push(...(scn.expect.verify?.(cwd) ?? []));
  // observability must be consistent with what happened
  if (!runSpan) failures.push("no sdlc.run span recorded");
  else if (runSpan.attributes["xcoder.outcome"] !== outcome) failures.push("span outcome attribute disagrees with engine outcome");
  const stageSpans = spans.filter((s) => s.name === "sdlc.stage").length;
  const ranStages = dag.filter((d) => d.attempts > 0).length;
  if (stageSpans !== ranStages) failures.push(`stage spans ${stageSpans} ≠ stages run ${ranStages}`);

  return {
    scenario: scn, cwd, outcome, pipeline,
    stages: dag.map((n) => ({ id: n.id, status: n.status, attempts: n.attempts, history: (n.history ?? []).map((h) => ({ attempt: h.attempt, outcome: h.outcome, detail: h.detail })) })),
    durationMs, llmCalls: llm.calls, spans, traceId, failures, answerHead: answer.slice(0, 160).replace(/\s+/g, " "),
  };
}

function spanTree(spans: ReadableSpan[]): string {
  const byParent = new Map<string, ReadableSpan[]>();
  for (const s of spans) {
    const p = s.parentSpanContext?.spanId ?? "";
    byParent.set(p, [...(byParent.get(p) ?? []), s]);
  }
  const lines: string[] = [];
  const walk = (id: string, depth: number) => {
    for (const s of (byParent.get(id) ?? []).sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1])) {
      const a = s.attributes;
      const label = s.name === "sdlc.run" ? `outcome=${a["xcoder.outcome"]} pipeline=${a["xcoder.pipeline"]}`
        : s.name === "sdlc.stage" ? `${a["xcoder.stage"]} status=${a["xcoder.stage.status"]} attempts=${a["xcoder.stage.attempts"]}`
        : s.name === "sdlc.attempt" ? `${a["xcoder.stage"]} #${a["xcoder.attempt"]}`
        : s.name === "sdlc.validate" ? `${a["xcoder.stage"]} pass=${a["xcoder.validation.pass"]}` : "";
      const ms = Math.round((s.endTime[0] - s.startTime[0]) * 1e3 + (s.endTime[1] - s.startTime[1]) / 1e6);
      lines.push(`${"  ".repeat(depth)}${s.name} ${label} (${ms}ms)${s.status.code === 2 ? " ✗" : ""}${s.events.length ? ` [${s.events.length} events]` : ""}`);
      walk(s.spanContext().spanId, depth + 1);
    }
  };
  walk("", 0);
  return lines.join("\n");
}

export function renderReport(results: ScenarioResult[], metricNames: string[]): string {
  const ok = results.every((r) => r.failures.length === 0);
  const out: string[] = [];
  out.push("# SDLC Scenario Run Report", "");
  out.push(`Generated ${new Date().toISOString()} — **${ok ? "ALL SCENARIOS AS EXPECTED" : "DEVIATIONS FOUND"}** (${results.filter((r) => r.failures.length === 0).length}/${results.length})`, "");
  out.push("**Real:** SdlcEngine, LeanEngine sub-agents, tool dispatcher (files written, shell commands run), command Validation Gates (real `node`/`bash` exit codes), checkpoints, rejection reports, OpenTelemetry spans & metrics.");
  out.push("**Scripted:** the developer LLM (no API key available). Its healing attempts are *reactive* — they apply the right fix only if the real gate-failure text reached them through the engine's healing prompt. LLM token figures are synthetic and omitted here.", "");
  out.push("| # | Input | Scenario | Pipeline | Per-stage attempts | Outcome | Time | Expected? |", "|---|---|---|---|---|---|---|---|");
  results.forEach((r, i) => out.push(`| ${i + 1} | ${r.scenario.input} | ${r.scenario.title} | \`${r.pipeline}\` | ${r.stages.map((s) => `${s.id}×${s.attempts}`).join(", ")} | ${r.outcome} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.failures.length ? "❌ " + r.failures.join("; ") : "✅"} |`));
  out.push("");
  for (const r of results) {
    out.push(`## ${r.scenario.input} — ${r.scenario.title}`, "", `Task: _${r.scenario.task}_`, "");
    for (const s of r.stages) {
      out.push(`- **${s.id}** → ${s.status} after ${s.attempts} attempt(s)`);
      for (const h of s.history) out.push(`  - attempt ${h.attempt}: ${h.outcome}${h.outcome === "passed" ? "" : ` — ${h.detail.slice(0, 260)}`}`);
    }
    out.push("", "Trace:", "```", spanTree(r.spans), "```", "");
  }
  out.push("## Metrics recorded", "", metricNames.map((n) => `- \`${n}\``).join("\n"), "");
  return out.join("\n");
}

export async function collectMetricNames(): Promise<string[]> {
  await meterProvider?.forceFlush();
  const last = metricExporter.getMetrics().at(-1);
  return [...new Set((last?.scopeMetrics ?? []).flatMap((s) => s.metrics.map((m) => m.descriptor.name)))].sort();
}

async function main(): Promise<void> {
  const only = process.argv[2];
  const results: ScenarioResult[] = [];
  for (const scn of SCENARIOS.filter((s) => !only || s.id === only)) {
    process.stdout.write(`▶ ${scn.input.padEnd(26)} ${scn.title} … `);
    const r = await runScenario(scn);
    results.push(r);
    console.log(r.failures.length ? `✗ ${r.failures.join("; ")}` : `✓ ${r.pipeline} (${r.stages.map((s) => `${s.id}×${s.attempts}`).join(" ")}) ${(r.durationMs / 1000).toFixed(1)}s`);
  }
  const report = renderReport(results, await collectMetricNames());
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "..", "..", "SDLC_SCENARIO_REPORT.md");
  fs.writeFileSync(file, report);
  console.log(`\nReport: ${file}`);
  process.exit(results.every((r) => r.failures.length === 0) ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main();
