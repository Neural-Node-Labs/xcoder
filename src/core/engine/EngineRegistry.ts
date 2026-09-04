// ronin:version 5 | ronin:task task-ac9eef | ronin:updated 2026-08-13T13:47:39.208Z | ronin:subtask code-st-f034f3
import { LlmClient, TelemetryInterface } from "../types.js";
import { AgentIO } from "../io/AgentIO.js";
import { IReactEngine } from "./IReactEngine.js";
import { ReActOrchestrator, OrchestratorOptions } from "../orchestrator.js";
import { LeanEngine, LeanEngineOptions } from "./LeanEngine.js";
import { SimpleReactEngine, SimpleReactEngineOptions } from "./SimpleReactEngine.js";
import { SwarmEngine, SwarmEngineOptions } from "./SwarmEngine.js";
import { AgenticEngine } from "./AgenticEngine.js";
import { BrainEngine } from "./BrainEngine.js";
import { ProcedureEngine } from "./ProcedureEngine.js";
import { SdlcEngine, SdlcEngineOptions } from "./SdlcEngine.js";

export interface EngineDeps {
  llm: LlmClient;
  telemetry: TelemetryInterface;
  io?: AgentIO;
  options?: OrchestratorOptions;
}

export type EngineFactory = (deps: EngineDeps) => IReactEngine;

const registry = new Map<string, EngineFactory>();

/** Register an engine implementation under a name. Call once at module load. */
export function registerEngine(name: string, factory: EngineFactory): void {
  registry.set(name, factory);
}

/** Instantiate a registered engine by name. Throws on an unknown name (with the known list). */
export function createEngine(name: string, deps: EngineDeps): IReactEngine {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`Unknown engine "${name}". Registered engines: ${listEngines().join(", ") || "(none)"}`);
  }
  return factory(deps);
}

export function listEngines(): string[] {
  return Array.from(registry.keys());
}

export const DEFAULT_ENGINE = "sdlc";

// The reference engine: the original ReAct loop, unchanged in behavior, just built against
// AgentIO instead of talking to stdio directly. Registered under its own literal name (not
// DEFAULT_ENGINE) so it stays reachable as "react" / --react even though it is no longer the
// default — see the "sdlc" registration below for what IS now the default engine.
registerEngine("react", ({ llm, telemetry, io, options }) => new ReActOrchestrator(llm, telemetry, { ...options, io }));

// The LeanEngine: a focused, self-contained ReAct loop that implements both IReactEngine and
// IReactEngineV2. Supports cancellation, progress observers, lifecycle state tracking, and
// self-healing health scoring. Does NOT include plan mode, phase planning, or subagent delegation
// — those live in the full ReActOrchestrator. This is the core loop, clean and testable.
registerEngine("lean", ({ llm, telemetry, io, options }) => {
  const leanOpts: LeanEngineOptions = {
    maxIterations: options?.maxIterations,
    cwd: options?.cwd,
    validateGoal: options?.validateGoal,
    maxValidatorRetries: options?.maxValidatorRetries,
    selfHealing: options?.selfHealing,
    consoleThoughts: options?.consoleThoughts,
    fullContextToken: options?.fullContextToken,
    io,
  };
  return new LeanEngine(llm, telemetry, leanOpts);
});

// SimpleReactEngine: one level simpler than "lean" — the bare ReAct loop with the same
// console output (thought/action/observation/usage) as ReActOrchestrator/LeanEngine, but no
// Plan Mode, no Phase Planning, no goal-validation retry loop, and no self-healing nudges.
// Whatever the model says when it stops calling tools IS the final answer. Context compaction
// and the truncation guard are still applied (those are correctness/cost fixes, not "planning").
registerEngine("simple", ({ llm, telemetry, io, options }) => {
  const simpleOpts: SimpleReactEngineOptions = {
    maxIterations: options?.maxIterations,
    cwd: options?.cwd,
    consoleThoughts: options?.consoleThoughts,
    fullContextToken: options?.fullContextToken,
    io,
  };
  return new SimpleReactEngine(llm, telemetry, simpleOpts);
});

// The SwarmEngine: an orchestrating ReAct engine that distributes tasks to swarm agents
// running in parallel. The Orchestrating Agent creates a detailed WBS plan, then assigns
// each task to a Swarm Agent with complete instructions. Swarm Agents report back status
// and results. Tasks with no dependencies run in parallel. A Goal Validator checks the
// Orchestrator at each ReAct loop iteration and grades its decisions.
registerEngine("swarm", ({ llm, telemetry, io, options }) => {
  const swarmOpts: SwarmEngineOptions = {
    maxIterations: options?.maxIterations,
    cwd: options?.cwd,
    validateGoal: options?.validateGoal,
    maxValidatorRetries: options?.maxValidatorRetries,
    selfHealing: options?.selfHealing,
    consoleThoughts: options?.consoleThoughts,
    fullContextToken: options?.fullContextToken,
    io,
    maxParallelAgents: 5,
  };
  return new SwarmEngine(llm, telemetry, swarmOpts);
});

// The AgenticEngine: deterministic agentic ReAct loop (port of the reference Python agentic_workflow) with
// an injectable ThinkFn. The default ThinkFn drives the loop through a MultiRoleRouter
// ("orchestrator" role) asking for a JSON AgentDecision each iteration; tests inject a
// scripted ThinkFn directly.
registerEngine("agentic", (deps) => new AgenticEngine(deps));

// The BrainEngine: exposes the shared MultiRoleRouter (port of the reference Python brain_workflow/router.py)
// as a callable engine. run() routes a task across >=2 roles (orchestrator + critic) and
// synthesizes the final answer.
registerEngine("brain", (deps) => new BrainEngine(deps));

// The ProcedureEngine: two-step procedure generation (plan -> strict JSON schema, port of
// the reference Python procedure_workflow/orchestrator.py) plus local step execution over the existing tool
// dispatcher. Returns the concatenated step outputs as the final answer.
registerEngine("procedure", (deps) => new ProcedureEngine(deps));

// The SdlcEngine: THE DEFAULT ENGINE (see DEFAULT_ENGINE above). A DAG-based SDLC
// orchestration engine (Task Factory intake classification -> linear SDLC stage DAG ->
// per-stage sub-agent -> independent Validation Gate -> bounded healing -> escalate-or-
// continue), modeled on the "blueprint" reference architecture. Unlike SwarmEngine's
// LLM-generated freeform WBS, the DAG here comes from an explicit, inspectable intake rule
// table (src/core/engine/SdlcEngine.ts's classifyIntake/buildDag), and every stage's
// deliverable is independently re-checked before the DAG is allowed to advance — a stage's
// own self-reported success is never trusted. See SdlcEngine.ts's top-of-file comment for
// the full list of what was and wasn't carried over from the blueprint.
registerEngine("sdlc", ({ llm, telemetry, io, options }) => {
  const sdlcOpts: SdlcEngineOptions = {
    cwd: options?.cwd,
    selfHealing: options?.selfHealing,
    consoleThoughts: options?.consoleThoughts,
    fullContextToken: options?.fullContextToken,
    agentMaxIterations: options?.maxIterations,
    io,
  };
  return new SdlcEngine(llm, telemetry, sdlcOpts);
});

// The "Assistant" orchestration engine: a lightweight, chat-first engine for direct
// conversation and small one-off tasks, driven from the new "Chat" tab under Run Task.
// Unlike "sdlc"/"swarm" it does no DAG planning, WBS breakdown, or multi-agent delegation —
// it's the same bare ReAct loop as "simple" (see above), just pointed at a system prompt
// written for back-and-forth conversation rather than "complete this SDLC deliverable and
// stop". It shares the exact same tool dispatcher as every other engine, so it can call
// any registered tool — including codegraph_tool (once CodeGraph is connected under
// Platform > Integrations) and mcp_tool (any local MCP server) — plus the same skill
// selection SimpleReactEngine already performs, giving it uniform access to tools, skills,
// and MCP without a bespoke code path.
const ASSISTANT_SYSTEM_PROMPT = `You are Assistant, xcoder's conversational engine. You handle direct chat and small,
self-contained requests — answering questions, explaining code, doing quick lookups, and
running the occasional one-off tool call — rather than full multi-stage SDLC work (that's
what the "sdlc"/"swarm" engines are for). You have the same tools every xcoder engine has:
workspace search and file tools, run_command_tool, github_tool, codegraph_tool (structural
code-graph queries, when CodeGraph is connected), and mcp_tool (call any local MCP server's
tools). Use a tool only when the request actually calls for it — for plain conversation,
just reply in plain text. Keep replies conversational and to the point.`;
registerEngine("assistant", ({ llm, telemetry, io, options }) => {
  const assistantOpts: SimpleReactEngineOptions = {
    maxIterations: options?.maxIterations,
    cwd: options?.cwd,
    consoleThoughts: options?.consoleThoughts,
    fullContextToken: options?.fullContextToken,
    systemPrompt: ASSISTANT_SYSTEM_PROMPT,
    io,
  };
  return new SimpleReactEngine(llm, telemetry, assistantOpts);
});
