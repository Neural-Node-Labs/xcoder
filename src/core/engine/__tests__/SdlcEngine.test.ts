import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SdlcEngine, classifyIntake, buildDag } from "../SdlcEngine.js";
import { LlmClient, LlmResponse, TelemetryInterface } from "../../types.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────────

function makeTelemetry(): TelemetryInterface {
  return {
    logThought: vi.fn(async () => {}),
    logLlmCall: vi.fn(async () => {}),
    logError: vi.fn(async () => {}),
  };
}

/**
 * A mock LLM that distinguishes between two call sites purely by shape:
 * - validateGoal() (the Validation Gate) always calls with { responseFormat: "json_object" }
 *   and expects a JSON `{ valid, reason }` string back.
 * - Everything else is a stage sub-agent's (LeanEngine) ReAct step, which should return no
 *   tool calls so the sub-agent terminates immediately with `stageContent` as its final answer.
 */
function makeMockLlm(opts: {
  stageContent?: string;
  validationSequence?: boolean[]; // per validateGoal() call, in order; last value repeats if exhausted
} = {}): LlmClient {
  const stageContent = opts.stageContent ?? "Stage deliverable produced.";
  const validationSequence = opts.validationSequence ?? [true];
  let validationCallIndex = 0;

  return {
    complete: vi.fn(async (_messages, callOpts?: { responseFormat?: string }): Promise<LlmResponse> => {
      if (callOpts?.responseFormat === "json_object") {
        const pass = validationSequence[Math.min(validationCallIndex, validationSequence.length - 1)];
        validationCallIndex += 1;
        return {
          content: JSON.stringify({ valid: pass, reason: pass ? "Meets acceptance criteria." : "Missing required behavior." }),
          toolCalls: [],
          reasoningContent: undefined,
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        };
      }
      return {
        content: stageContent,
        toolCalls: [],
        reasoningContent: undefined,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    }),
  };
}

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── classifyIntake ─────────────────────────────────────────────────────────────────

describe("classifyIntake", () => {
  it("classifies a URL-bearing task as ui_api_test", () => {
    expect(classifyIntake("verify the login flow", { url: "https://example.com" })).toBe("ui_api_test");
  });

  it("classifies existing code + defect signal as refactor", () => {
    expect(classifyIntake("this is broken, please fix it", { hasCode: true })).toBe("refactor");
    expect(classifyIntake("add a feature", { hasCode: true, hasDefect: true })).toBe("refactor");
  });

  it("classifies existing code + testing language (no defect) as test", () => {
    expect(classifyIntake("write tests for the parser module", { hasCode: true })).toBe("test");
  });

  it("classifies a design without code as code", () => {
    expect(classifyIntake("implement this from the design doc", { hasDesign: true })).toBe("code");
  });

  it("classifies a plain question with no code/url signal as conversation", () => {
    expect(classifyIntake("what does this function do?")).toBe("conversation");
    expect(classifyIntake("how should I structure this project?")).toBe("conversation");
  });

  it("defaults to requirements when nothing else matches", () => {
    expect(classifyIntake("build a task management app")).toBe("requirements");
  });

  it("is a pure, deterministic rule table — same input always yields the same stage", () => {
    const a = classifyIntake("fix the login bug", { hasCode: true, hasDefect: true });
    const b = classifyIntake("fix the login bug", { hasCode: true, hasDefect: true });
    expect(a).toBe(b);
  });
});

// ─── buildDag ───────────────────────────────────────────────────────────────────────

describe("buildDag", () => {
  it("produces a single conversation node with no dependencies", () => {
    const dag = buildDag("conversation");
    expect(dag).toHaveLength(1);
    expect(dag[0]).toMatchObject({ id: "conversation", stage: "conversation", dependencies: [] });
  });

  it("builds a linear chain from requirements through the default backbone, excluding optional stages", () => {
    const dag = buildDag("requirements");
    const ids = dag.map((n) => n.id);
    expect(ids).toEqual(["requirements", "design", "code", "test"]);
    // linear chain: each node depends only on its immediate predecessor
    expect(dag[0].dependencies).toEqual([]);
    expect(dag[1].dependencies).toEqual(["requirements"]);
    expect(dag[2].dependencies).toEqual(["design"]);
    expect(dag[3].dependencies).toEqual(["code"]);
  });

  it("includes document/deploy only when explicitly opted in", () => {
    const withoutExtras = buildDag("requirements");
    expect(withoutExtras.map((n) => n.id)).not.toContain("document");
    expect(withoutExtras.map((n) => n.id)).not.toContain("deploy");

    const withExtras = buildDag("requirements", { includeDocument: true, includeDeploy: true });
    expect(withExtras.map((n) => n.id)).toEqual(["requirements", "design", "code", "test", "document", "deploy"]);
  });

  it("includes refactor only when it is the classified starting stage", () => {
    const dag = buildDag("refactor");
    expect(dag[0].id).toBe("refactor");
    expect(dag.map((n) => n.id)).not.toContain("ui_api_test");
    expect(dag.map((n) => n.id)).not.toContain("fix_defect");
  });

  it("assigns the correct role per stage", () => {
    const dag = buildDag("requirements");
    const roleById = Object.fromEntries(dag.map((n) => [n.id, n.role]));
    expect(roleById.requirements).toBe("business-analyst");
    expect(roleById.design).toBe("architect");
    expect(roleById.code).toBe("programmer");
    expect(roleById.test).toBe("tester");
  });

  it("defaults every node's acceptance criteria to rubric unless overridden", () => {
    const dag = buildDag("requirements", { acceptanceOverrides: { code: { type: "command", command: "npm test" } } });
    const byId = Object.fromEntries(dag.map((n) => [n.id, n.acceptance]));
    expect(byId.requirements).toEqual({ type: "rubric" });
    expect(byId.code).toEqual({ type: "command", command: "npm test" });
  });
});

// ─── SdlcEngine.run() ───────────────────────────────────────────────────────────────

describe("SdlcEngine.run()", () => {
  it("runs a conversation-classified task as a single validated node", async () => {
    const cwd = makeTmpDir("sdlc-conv-");
    const llm = makeMockLlm({ stageContent: "Here is the explanation you asked for." });
    const engine = new SdlcEngine(llm, makeTelemetry(), { cwd, persistArtifacts: false });

    const answer = await engine.run("what does this function do?");

    expect(answer).toContain("Here is the explanation you asked for.");
    expect(engine.getLastOutcome()).toBe("completed");
    expect(engine.getHealthScore()).toBe(100);
  });

  it("runs the full default pipeline in dependency order and returns every stage's output", async () => {
    const cwd = makeTmpDir("sdlc-pipeline-");
    const llm = makeMockLlm({ stageContent: "Deliverable OK." });
    const engine = new SdlcEngine(llm, makeTelemetry(), { cwd, persistArtifacts: false });

    const answer = await engine.run("build a task management app");

    expect(engine.getLastOutcome()).toBe("completed");
    for (const stage of ["requirements", "design", "code", "test"]) {
      expect(answer).toContain(`## ${stage}`);
    }
  });

  it("heals a stage that fails validation once, then passes on retry", async () => {
    const cwd = makeTmpDir("sdlc-heal-");
    // First validateGoal() call (for the first stage, "requirements") fails; every call after
    // that passes -- so the very first stage should show attempts === 2 (one heal), and the
    // whole pipeline should still complete.
    const llm = makeMockLlm({ validationSequence: [false, true, true, true] });
    const engine = new SdlcEngine(llm, makeTelemetry(), { cwd, persistArtifacts: false, maxHealingAttempts: 2 });

    const answer = await engine.run("build a task management app");

    expect(engine.getLastOutcome()).toBe("completed");
    expect(answer).toContain("## requirements");
    // healed pass scores 65, not 100 -- confirms the healing path was actually exercised
    expect(engine.getHealthScore()).toBeLessThan(100);
  });

  it("escalates and halts the DAG after exhausting healing attempts, writing a rejection report", async () => {
    const cwd = makeTmpDir("sdlc-escalate-");
    const llm = makeMockLlm({ validationSequence: [false, false, false] }); // always fails
    const engine = new SdlcEngine(llm, makeTelemetry(), { cwd, maxHealingAttempts: 1 });

    const answer = await engine.run("build a task management app");

    expect(engine.getLastOutcome()).toBe("partial_completion");
    expect(answer).toContain("halted at stage");
    expect(engine.getHealthScore()).toBe(0);

    const reportsDir = path.join(cwd, ".agent", "reports");
    const files = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : [];
    expect(files.some((f) => f.includes("-requirements-rejection.md"))).toBe(true);
  });
/** TODO SJMN
  it("supports a command-type acceptance criteria, re-running the declared shell command", async () => {
    const cwd = makeTmpDir("sdlc-cmd-");
    const llm = makeMockLlm({ stageContent: "Wrote the code." });
    const engine = new SdlcEngine(llm, makeTelemetry(), {
      cwd,
      persistArtifacts: false,
      intake: { hasDesign: true }, // classifies straight to "code"
      acceptanceOverrides: { code: { type: "command", command: "true" } }, // always exits 0
    });

    const answer = await engine.run("implement the reviewed design");

    // TODO SJMN expect(engine.getLastOutcome()).toBe("completed");
    expect(answer).toContain("## code");
  });
**/
  it("escalates when a command-type acceptance criteria's command fails", async () => {
    const cwd = makeTmpDir("sdlc-cmd-fail-");
    const llm = makeMockLlm({ stageContent: "Wrote the code." });
    const engine = new SdlcEngine(llm, makeTelemetry(), {
      cwd,
      maxHealingAttempts: 0,
      intake: { hasDesign: true },
      acceptanceOverrides: { code: { type: "command", command: "false" } }, // always exits 1
    });

    const answer = await engine.run("implement the reviewed design");

    expect(engine.getLastOutcome()).toBe("partial_completion");
    expect(answer).toContain("halted at stage \"code\"");
  });

  it("persists DAG state under .agent/tasks after a run", async () => {
    const cwd = makeTmpDir("sdlc-state-");
    const llm = makeMockLlm();
    const engine = new SdlcEngine(llm, makeTelemetry(), { cwd, intake: { url: "https://example.com" } });

    await engine.run("check the live site works");

    const tasksDir = path.join(cwd, ".agent", "tasks");
    const files = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : [];
    expect(files.some((f) => f.endsWith("-sdlc-state.json"))).toBe(true);
  });
});

// ─── Isolation ──────────────────────────────────────────────────────────────────────

describe("SdlcEngine isolation", () => {
  it("never rejects run() even when a stage's sub-agent crashes outside its own healing loop", async () => {
    const cwd = makeTmpDir("sdlc-isolate-");
    const telemetry = makeTelemetry();
    // Every completion throws -- this crashes LeanEngine's very first llm.complete() call
    // inside runNodeWithHealing's try/catch, which is expected to convert it into healing then
    // escalation rather than letting it propagate. run() must still resolve, not reject.
    const llm: LlmClient = { complete: vi.fn(async () => { throw new Error("simulated swarm agent crash"); }) };
    const engine = new SdlcEngine(llm, telemetry, { cwd, maxHealingAttempts: 1 });

    const answer = await engine.run("build a task management app");

    expect(engine.getLastOutcome()).toBe("partial_completion");
    expect(answer).toContain("halted at stage");
    expect(telemetry.logError).toHaveBeenCalled();
  });

  it("still produces a final report and does not throw even if writing the rejection report to disk fails", async () => {
    // Point cwd at a path that cannot possibly be created (a file, not a directory, in the
    // middle of the path) so fs.mkdirSync inside writeRejectionReport throws ENOTDIR.
    const cwd = makeTmpDir("sdlc-diskfail-");
    const blockerFile = path.join(cwd, "blocker");
    fs.writeFileSync(blockerFile, "not a directory");
    const badCwd = path.join(blockerFile, "nested"); // .agent/reports under here can't be created

    const llm = makeMockLlm({ validationSequence: [false, false] });
    const engine = new SdlcEngine(llm, makeTelemetry(), { cwd: badCwd, maxHealingAttempts: 0 });

    await expect(engine.run("build a task management app")).resolves.toEqual(expect.any(String));
    expect(engine.getLastOutcome()).toBe("partial_completion");
  });

  it("contains a single stage's failure without preventing an already-completed stage's result from being reported", async () => {
    const cwd = makeTmpDir("sdlc-partial-");
    // requirements passes; design fails every attempt and escalates. The completed
    // "requirements" stage's output must still show up in the final answer.
    const llm = makeMockLlm({ validationSequence: [true, false, false] });
    const engine = new SdlcEngine(llm, makeTelemetry(), { cwd, maxHealingAttempts: 1 });

    const answer = await engine.run("build a task management app");

    expect(answer).toContain("Completed stages");
    expect(answer).toContain("[requirements]");
    expect(answer).toContain('halted at stage "design"');
  });
});

// ─── Spinner + thought/action/observation instrumentation ──────────────────────────

describe("SdlcEngine console instrumentation", () => {
  it("wraps the Validation Gate's rubric check with a spinner and reports action/observation", async () => {
    const cwd = makeTmpDir("sdlc-spinner-");
    const llm = makeMockLlm();
    const spinnerStart = vi.fn();
    const spinnerStop = vi.fn();
    const action = vi.fn();
    const observation = vi.fn();
    const io = {
      log: vi.fn(), warn: vi.fn(), error: vi.fn(),
      thought: vi.fn(), action, observation,
      healthWarning: vi.fn(), subagentStart: vi.fn(), usage: vi.fn(), totalUsage: vi.fn(), phaseStats: vi.fn(),
      spinnerStart, spinnerStop,
      confirm: vi.fn(async () => true), prompt: vi.fn(async () => ""),
    } as any;
    const engine = new SdlcEngine(llm, makeTelemetry(), { cwd, persistArtifacts: false, io });

    await engine.run("what does this do?");

    expect(spinnerStart).toHaveBeenCalledWith("Validating stage...");
    expect(spinnerStop).toHaveBeenCalled();
    expect(action).toHaveBeenCalledWith("validation_gate", expect.objectContaining({ stage: "conversation", type: "rubric" }));
    expect(observation).toHaveBeenCalled();
  });

/** TODO SJMN: re-enable this test once we have a way to mock out the actual command execution in a cross-platform way
  it("reports action/observation for a command-type Validation Gate check", async () => {
    const cwd = makeTmpDir("sdlc-spinner-cmd-");
    const llm = makeMockLlm({ stageContent: "done" });
    const action = vi.fn();
    const observation = vi.fn();
    const io = {
      log: vi.fn(), warn: vi.fn(), error: vi.fn(),
      thought: vi.fn(), action, observation,
      healthWarning: vi.fn(), subagentStart: vi.fn(), usage: vi.fn(), totalUsage: vi.fn(), phaseStats: vi.fn(),
      spinnerStart: vi.fn(), spinnerStop: vi.fn(),
      confirm: vi.fn(async () => true), prompt: vi.fn(async () => ""),
    } as any;
    const engine = new SdlcEngine(llm, makeTelemetry(), {
      cwd, persistArtifacts: false, io,
      intake: { hasDesign: true },
      acceptanceOverrides: { code: { type: "command", command: "true" } },
    });

    await engine.run("implement the reviewed design");

    expect(action).toHaveBeenCalledWith("validation_gate", expect.objectContaining({ stage: "code", type: "command", command: "true" }));
    expect(observation).toHaveBeenCalledWith(expect.stringContaining("exited 0"), false);
  });
  **/
});

describe("SdlcEngine lifecycle surface", () => {
  it("generatePlan() describes the DAG without executing anything", async () => {
    const llm = makeMockLlm();
    const engine = new SdlcEngine(llm, makeTelemetry(), { cwd: "/tmp/sdlc-plan" });

    const plan = await engine.generatePlan("build a task management app");

    expect(plan).toContain("requirements");
    expect(plan).toContain("design");
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("reports workspace path from options.cwd", () => {
    const engine = new SdlcEngine(makeMockLlm(), makeTelemetry(), { cwd: "/tmp/sdlc-ws" });
    expect(engine.getWorkspacePath()).toBe("/tmp/sdlc-ws");
  });

  it("cancel() is idempotent and transitions state to cancelled", () => {
    const engine = new SdlcEngine(makeMockLlm(), makeTelemetry(), { cwd: "/tmp/sdlc-cancel" });
    expect(engine.getState()).toEqual({ phase: "idle" });
    // cancel() on an idle engine is a no-op per the IReactEngineV2 contract
    engine.cancel("test");
    expect(engine.getState()).toEqual({ phase: "idle" });
  });

  it("onProgress() notifies observers of phase transitions during a run", async () => {
    const cwd = makeTmpDir("sdlc-progress-");
    const engine = new SdlcEngine(makeMockLlm(), makeTelemetry(), { cwd, persistArtifacts: false });
    const seen: string[] = [];
    const unsubscribe = engine.onProgress((state) => seen.push(state.phase));

    await engine.run("what does this do?");

    expect(seen).toContain("planning");
    expect(seen).toContain("running");
    expect(seen).toContain("completed");
    unsubscribe();
  });
});
