import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { LlmClient } from "./types.js";
import { ReActOrchestrator } from "./orchestrator.js";
import { FileTelemetry } from "../telemetry/logger.js";
import { findDuplicateActions, ToolCallRecord } from "./duplicateActionDetector.js";
import { auditReactLoop, defaultScenarios, AuditReport } from "./reactAuditor.js";
import { SkillRegistry } from "./skillRegistry.js";
import { resolveThinkingLogPath } from "../config/paths.js";

interface ThinkingLogEntry {
  iteration: number;
  phase: string;
  thought: string;
  action?: { tool: string; input: unknown };
  observation?: unknown;
}

export interface DiagnosticResult {
  id: string;
  title: string;
  passed: boolean;
  evidence: string[];
}

export interface LiveDiagnosticsReport {
  timestamp: string;
  model: string;
  results: DiagnosticResult[];
  summary: { total: number; passed: number };
  markdown: string;
}

function readThinkingLog(dir: string): ThinkingLogEntry[] {
  const p = resolveThinkingLogPath(dir);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line.slice(line.indexOf("{"))) as ThinkingLogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is ThinkingLogEntry => e !== null);
}

function newWorkspace(baseDir: string, name: string): string {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// 1. ReAct iteration ends when the task is genuinely successful
// ---------------------------------------------------------------------------
async function diagnoseIterationEndsOnSuccess(llm: LlmClient, baseDir: string): Promise<DiagnosticResult> {
  const dir = newWorkspace(baseDir, "d1-iteration-stop");
  fs.writeFileSync(path.join(dir, "check.js"), "console.log('ready');\n");
  const telemetry = new FileTelemetry(dir);
  const orchestrator = new ReActOrchestrator(llm, telemetry, { cwd: dir, maxIterations: 8, planMode: "never" });

  const result = await orchestrator.run("Run check.js and confirm it prints 'ready'. Then report completion.");
  const entries = readThinkingLog(dir);
  const iterationsUsed = entries.length ? Math.max(...entries.map((e) => e.iteration)) : 0;

  const passed = result.length > 0 && iterationsUsed > 0 && iterationsUsed < 8;
  return {
    id: "1",
    title: "ReAct iteration ends when the task is successful (not truncated at the ceiling)",
    passed,
    evidence: [
      `Final result: "${result}"`,
      `Iterations used: ${iterationsUsed} (ceiling was 8)`,
      passed
        ? "Loop terminated naturally before hitting the ceiling."
        : "Loop either produced no result or ran all the way to the ceiling — did not terminate naturally.",
    ],
  };
}

// ---------------------------------------------------------------------------
// 2. Restart-approval flow: asks when it needs more iterations, resumes correctly once approved
// ---------------------------------------------------------------------------
async function diagnoseRestartApproval(llm: LlmClient, baseDir: string): Promise<DiagnosticResult> {
  const dir = newWorkspace(baseDir, "d2-restart-approval");
  fs.writeFileSync(path.join(dir, "steps.js"), "console.log(1);\nconsole.log(2);\nconsole.log(3);\n");
  const telemetry = new FileTelemetry(dir);

  let callbackInvocations = 0;

  const orchestrator = new ReActOrchestrator(llm, telemetry, {
    cwd: dir,
    maxIterations: 2,
    planMode: "never",
    onIterationLimitReached: async () => {
      callbackInvocations += 1;
      return true;
    },
  });

  const result = await orchestrator.run(
    "Read steps.js, then run it, then also run `echo done` as a separate step, then report all three outputs explicitly before finishing."
  );

  const entries = readThinkingLog(dir);
  const restartLogEntries = entries.filter((e) => e.action?.tool === "iteration_limit_check");

  const passed = callbackInvocations > 0 && restartLogEntries.length === callbackInvocations && result.length > 0;
  return {
    id: "2",
    title: "ReAct asks to restart the loop counter when it needs more iterations, and resumes correctly once approved",
    passed,
    evidence: [
      `Restart callback invoked ${callbackInvocations} time(s) with maxIterations=2.`,
      `Telemetry recorded ${restartLogEntries.length} matching iteration_limit_check entries.`,
      `Final result after restart(s): "${result}"`,
      callbackInvocations === 0
        ? "Task completed within the initial ceiling — restart mechanism was not exercised. Re-run with a bigger task or lower ceiling to force it."
        : "Restart mechanism was exercised and the task continued past the original ceiling.",
    ],
  };
}

// ---------------------------------------------------------------------------
// 3. No wasteful duplicate reasoning/action within the same loop
// ---------------------------------------------------------------------------
async function diagnoseNoDuplicateActions(llm: LlmClient, baseDir: string): Promise<DiagnosticResult> {
  const dir = newWorkspace(baseDir, "d3-no-duplicates");
  fs.writeFileSync(path.join(dir, "flaky.js"), "function compute() { return 2 + 2; }\nconsole.log(compute());\n");
  const telemetry = new FileTelemetry(dir);
  const orchestrator = new ReActOrchestrator(llm, telemetry, { cwd: dir, maxIterations: 8, planMode: "never" });

  const result = await orchestrator.run(
    "Read flaky.js, run it, confirm the output is 4, and report completion. Don't repeat a check you've already done with no new information."
  );

  const entries = readThinkingLog(dir);
  const calls: ToolCallRecord[] = entries
    .filter((e) => e.action?.tool && e.action.tool !== "goal_validator" && e.action.tool !== "iteration_limit_check")
    .map((e) => ({ tool: e.action!.tool, args: e.action!.input, observation: e.observation }));

  const violations = findDuplicateActions(calls);
  const passed = violations.length === 0 && result.length > 0;

  return {
    id: "3",
    title: "No duplicate reason/action in the same loop — the model doesn't blindly retry something it already tried with no new information",
    passed,
    evidence: [
      `Total tool calls made: ${calls.length}.`,
      `Wasteful exact-duplicate calls found: ${violations.length}.`,
      ...violations.map((v) => `  - ${v.tool}(${JSON.stringify(v.args)}) repeated ${v.occurrences}x with identical results: ${v.reason}`),
    ],
  };
}

// ---------------------------------------------------------------------------
// 4. Tools and skills are effectively used
// ---------------------------------------------------------------------------
async function diagnoseToolsAndSkillsUsed(llm: LlmClient, baseDir: string): Promise<DiagnosticResult> {
  const dir = newWorkspace(baseDir, "d4-tools-and-skills");
  const registry = new SkillRegistry();
  const task =
    "Write a Dockerfile for a minimal Node.js app in this workspace and verify it's syntactically sane by checking it contains FROM, WORKDIR, and CMD instructions.";
  const routedSkills = registry.route(task);

  const telemetry = new FileTelemetry(dir);
  const orchestrator = new ReActOrchestrator(llm, telemetry, { cwd: dir, maxIterations: 8, planMode: "never" });
  const result = await orchestrator.run(task);

  const entries = readThinkingLog(dir);
  const realToolCalls = entries.filter(
    (e) => e.action?.tool && !["goal_validator", "iteration_limit_check"].includes(e.action.tool)
  );
  const successfulCalls = realToolCalls.filter((e) => {
    const obs = e.observation as any;
    return obs && (obs.exitCode === 0 || obs.file || obs.files || obs.content !== undefined || obs.bytesWritten !== undefined);
  });

  const dockerfileExists = fs.existsSync(path.join(dir, "Dockerfile"));
  const passed = routedSkills.length > 0 && successfulCalls.length > 0 && dockerfileExists;

  return {
    id: "4",
    title: "DeepSeek effectively uses xcoder's tools and skills (not just talking about the task)",
    passed,
    evidence: [
      `Skills routed for this task: ${routedSkills.map((s) => s.name).join(", ") || "(none)"}`,
      `Real tool calls made: ${realToolCalls.length}, of which ${successfulCalls.length} succeeded.`,
      `Dockerfile actually created: ${dockerfileExists}`,
      `Final result: "${result}"`,
    ],
  };
}

// ---------------------------------------------------------------------------
// 5. Build a deployable application from the ground up
// ---------------------------------------------------------------------------
async function verifyHttpServer(
  dir: string,
  entryFile: string,
  port: number,
  healthPath: string,
  timeoutMs = 8000
): Promise<{ up: boolean; detail: string }> {
  const entryPath = path.join(dir, entryFile);
  if (!fs.existsSync(entryPath)) return { up: false, detail: `${entryFile} does not exist` };

  const child = spawn("node", [entryFile], { cwd: dir, env: { ...process.env, PORT: String(port) } });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d.toString()));

  const start = Date.now();
  let lastError = "";
  try {
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`http://localhost:${port}${healthPath}`);
        if (res.ok) return { up: true, detail: `GET ${healthPath} -> ${res.status}` };
        lastError = `GET ${healthPath} -> ${res.status}`;
      } catch (err) {
        lastError = String(err);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return {
      up: false,
      detail: `Server never responded successfully within ${timeoutMs}ms. Last error: ${lastError}. stderr: ${stderr.slice(0, 300)}`,
    };
  } finally {
    child.kill();
  }
}

async function diagnoseGroundUpDeployableApp(llm: LlmClient, baseDir: string): Promise<DiagnosticResult> {
  const dir = newWorkspace(baseDir, "d5-ground-up-app");
  const port = 41000 + Math.floor(Math.random() * 5000);
  const telemetry = new FileTelemetry(dir);
  const orchestrator = new ReActOrchestrator(llm, telemetry, { cwd: dir, maxIterations: 15, planMode: "never" });

  const task =
    "Build a minimal, deployable Node.js HTTP server from scratch in this workspace: a file named server.js " +
    "using only Node's built-in 'http' module (no dependencies), listening on process.env.PORT, with a GET " +
    "/health endpoint returning HTTP 200 and body \"ok\". Also add a Dockerfile (FROM node, COPY, CMD to run " +
    "server.js) so it's deployable. Verify server.js actually works before declaring done.";

  const result = await orchestrator.run(task);

  const dockerfilePath = path.join(dir, "Dockerfile");
  const dockerfileExists = fs.existsSync(dockerfilePath);
  const dockerfileContent = dockerfileExists ? fs.readFileSync(dockerfilePath, "utf-8") : "";
  const dockerfileLooksReal = /FROM/i.test(dockerfileContent) && /CMD|ENTRYPOINT/i.test(dockerfileContent);

  const serverCheck = await verifyHttpServer(dir, "server.js", port, "/health");

  const dockerAvailable = spawnSync("which", ["docker"]).status === 0;
  let dockerBuildResult = "docker not available on this machine — skipped actual image build.";
  if (dockerAvailable && dockerfileExists) {
    const build = spawnSync("docker", ["build", "-t", "xcoder-diag-app", dir], { timeout: 120_000, encoding: "utf-8" });
    dockerBuildResult = build.status === 0 ? "docker build succeeded." : `docker build FAILED: ${(build.stderr ?? "").slice(0, 300)}`;
  }

  const passed = serverCheck.up && dockerfileExists && dockerfileLooksReal;

  return {
    id: "5",
    title: "DeepSeek can complete an application from the ground up that is deployable",
    passed,
    evidence: [
      `Independently started server.js and checked GET /health: up=${serverCheck.up} — ${serverCheck.detail}`,
      `Dockerfile exists: ${dockerfileExists}, looks structurally real (FROM + CMD/ENTRYPOINT): ${dockerfileLooksReal}`,
      dockerBuildResult,
      `Final agent claim: "${result}"`,
    ],
  };
}

// ---------------------------------------------------------------------------
// 6. Bug fixing — reuses the existing, independently-verified scenario battery
// ---------------------------------------------------------------------------
async function diagnoseBugFixing(
  llm: LlmClient,
  modelLabel: string,
  baseDir: string
): Promise<{ result: DiagnosticResult; auditReport: AuditReport }> {
  const auditReport = await auditReactLoop(llm, modelLabel, defaultScenarios(), {
    baseDir: newWorkspace(baseDir, "d6-bug-fixing"),
  });
  const passed = auditReport.summary.passed === auditReport.summary.total;
  return {
    result: {
      id: "6",
      title: "DeepSeek can fix bugs (independently re-verified, not just trusted on its own claim)",
      passed,
      evidence: [
        `${auditReport.summary.passed}/${auditReport.summary.total} bug-fixing scenarios independently verified as actually fixed.`,
        `Total invariant violations across scenarios: ${auditReport.summary.totalInvariantViolations}.`,
        `Avg LLM calls per scenario: ${auditReport.summary.avgLlmCalls.toFixed(1)}.`,
        ...auditReport.scenarios.map((s) => `  - ${s.passed ? "PASS" : "FAIL"} ${s.name}: ${s.independentVerification.detail}`),
      ],
    },
    auditReport,
  };
}

// ---------------------------------------------------------------------------
// 7. Full SDLC: design -> develop -> test -> fix -> production-ready
// ---------------------------------------------------------------------------
async function diagnoseFullSdlc(llm: LlmClient, baseDir: string): Promise<DiagnosticResult> {
  const dir = newWorkspace(baseDir, "d7-full-sdlc");
  const telemetry = new FileTelemetry(dir);
  const orchestrator = new ReActOrchestrator(llm, telemetry, { cwd: dir, maxIterations: 25, planMode: "never" });

  const task =
    "Design and build a small in-memory 'todo list' HTTP API in Node.js (no external dependencies): " +
    "POST /todos {text} adds one, GET /todos lists them all as JSON, POST /todos/:id/complete marks one done. " +
    "Write it, write a test script (test.js, using Node's built-in assert + http requests against a running " +
    "instance) that exercises all three endpoints, run the tests and fix any failures, then add a Dockerfile " +
    "so it's production-ready. Verify the whole thing actually works end to end before declaring done.";

  const result = await orchestrator.run(task);
  const entries = readThinkingLog(dir);

  const usedValidationTool = entries.some((e) => e.action?.tool === "run_command_tool");
  const hasServerFile =
    fs.existsSync(path.join(dir, "server.js")) ||
    fs.existsSync(path.join(dir, "index.js")) ||
    fs.existsSync(path.join(dir, "app.js"));
  const hasTestFile = fs.readdirSync(dir).some((f) => /test/i.test(f));
  const hasDockerfile = fs.existsSync(path.join(dir, "Dockerfile"));

  let testRunResult = "no recognizable test file found to independently re-run";
  const testFile = fs.readdirSync(dir).find((f) => /test/i.test(f) && f.endsWith(".js"));
  if (testFile) {
    const run = spawnSync("node", [testFile], { cwd: dir, timeout: 15_000, encoding: "utf-8" });
    testRunResult =
      run.status === 0
        ? "independently re-ran the test file: PASSED (exit 0)"
        : `independently re-ran the test file: FAILED (exit ${run.status}) — ${(run.stderr ?? "").slice(0, 300)}`;
  }

  const passed = hasServerFile && hasTestFile && hasDockerfile && testRunResult.includes("PASSED");

  return {
    id: "7",
    title: "DeepSeek can perform the full cycle: design -> develop -> test -> fix -> production-ready",
    passed,
    evidence: [
      `Server/app file present: ${hasServerFile}`,
      `Test file present: ${hasTestFile}`,
      `Dockerfile present (production-ready packaging): ${hasDockerfile}`,
      `Used run_command_tool at least once (validated, not just assumed): ${usedValidationTool}`,
      `Independent re-run of the test file: ${testRunResult}`,
      `Final agent claim: "${result}"`,
    ],
  };
}

export async function runLiveDiagnostics(
  llm: LlmClient,
  modelLabel: string,
  opts: { baseDir?: string } = {}
): Promise<LiveDiagnosticsReport> {
  const baseDir = opts.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-live-diagnostics-"));
  const results: DiagnosticResult[] = [];

  results.push(await diagnoseIterationEndsOnSuccess(llm, baseDir));
  results.push(await diagnoseRestartApproval(llm, baseDir));
  results.push(await diagnoseNoDuplicateActions(llm, baseDir));
  results.push(await diagnoseToolsAndSkillsUsed(llm, baseDir));
  results.push(await diagnoseGroundUpDeployableApp(llm, baseDir));
  const { result: bugFixResult } = await diagnoseBugFixing(llm, modelLabel, baseDir);
  results.push(bugFixResult);
  results.push(await diagnoseFullSdlc(llm, baseDir));

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;

  const report: LiveDiagnosticsReport = {
    timestamp: new Date().toISOString(),
    model: modelLabel,
    results,
    summary: { total, passed },
    markdown: "",
  };
  report.markdown = renderMarkdown(report, baseDir);
  return report;
}

function renderMarkdown(report: LiveDiagnosticsReport, baseDir: string): string {
  const lines: string[] = [];
  lines.push(`# xcoder Live ReAct Diagnostics (real ${report.model} connection)`);
  lines.push(`Generated: ${report.timestamp}`);
  lines.push(`Workspace: ${baseDir}`);
  lines.push("");
  lines.push(`## Summary: ${report.summary.passed}/${report.summary.total} diagnostics passed`);
  lines.push("");
  for (const r of report.results) {
    lines.push(`## ${r.passed ? "✅" : "❌"} ${r.id}. ${r.title}`);
    for (const e of r.evidence) lines.push(`- ${e}`);
    lines.push("");
  }
  return lines.join("\n");
}


