import { LlmClient, LlmMessage, LlmResponse, LlmUsage, ToolCall } from "../core/types.js";

/**
 * Naka-script na LlmClient para sa tests/dev: nagbabalik ng paunang-nakaprogramang sunod-sunod
 * na mga sagot para masuri ang tool-dispatch loop ng orchestrator nang hindi kailangang
 * tumawag sa tunay na API.
 */
export class MockLlmClient implements LlmClient {
  private callIndex = 0;
  public seenMessages: LlmMessage[][] = [];

  constructor(private script: LlmResponse[]) {}

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    this.seenMessages.push(structuredClone(messages));
    const response = this.script[this.callIndex] ?? { content: "(no more scripted responses)", toolCalls: [] };
    this.callIndex += 1;
    return response;
  }
}

export function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/**
 * AutoMockLlmClient — a general-purpose, no-scripting-required stand-in for a real LLM
 * connection, powering `--mock` (CLI) and `DEVNULL_MOCK_LLM=1` (API server). Unlike
 * MockLlmClient above (which needs a hand-written response script and is meant for unit
 * tests exercising one specific scenario), this client answers ANY task, from any engine,
 * with zero configuration — so a person can try the whole platform (engine selection, the
 * SDLC DAG, the Validation Gate, plan approval, health scoring, the web dashboard) with no
 * API key and no network access at all.
 *
 * Behavior, by request shape:
 * - `responseFormat: "json_object"` (the Validation Gate's rubric check, and any engine's
 *   structured-decision calls, e.g. AgenticEngine's think step) — returns a superset JSON
 *   object containing every field any current caller reads (`valid`, `reason`, `phase`,
 *   `thought`, `tool`, `tool_input`, `done`, `final_answer`). Extra fields a given caller
 *   doesn't look at are simply ignored, so one shape safely serves every JSON-mode caller
 *   in the codebase without needing to know which one is asking.
 * - Everything else (a ReAct step, a plan-generation call, a procedure-generation call, a
 *   role-router call) — returns a single canned completion with NO tool calls, so every
 *   ReAct-shaped loop terminates in exactly one iteration per stage/phase it's asked to run,
 *   rather than attempting real multi-step tool orchestration against fake data. The content
 *   is always prefixed `[MOCK]` so it's never mistaken for a genuine model response, and
 *   echoes back a short excerpt of what was asked so the surrounding UI/console output still
 *   reads coherently (e.g. in the SDLC DAG's per-stage output, or a task history entry).
 *
 * Every response includes small, deterministic, plausible `usage` numbers (not all-zero) so
 * token counters, health scores, and usage summaries in the CLI and dashboard still render
 * something meaningful rather than blank/undefined fields.
 */
export class AutoMockLlmClient implements LlmClient {
  private callCount = 0;
  public seenMessages: LlmMessage[][] = [];

  async complete(
    messages: LlmMessage[],
    opts?: { model?: string; temperature?: number; tools?: unknown; responseFormat?: "json_object" }
  ): Promise<LlmResponse> {
    this.callCount += 1;
    this.seenMessages.push(structuredClone(messages));

    const usage: LlmUsage = {
      promptTokens: 120 + this.callCount * 4,
      completionTokens: 40 + this.callCount * 2,
      totalTokens: 160 + this.callCount * 6,
    };

    if (opts?.responseFormat === "json_object") {
      const payload = {
        valid: true,
        reason: "(mock) auto-approved — no real Validation Gate check was performed",
        phase: "search",
        thought: "(mock) proceeding without a real model",
        tool: "none",
        tool_input: "",
        done: true,
        final_answer: this.canned(messages),
      };
      return { content: JSON.stringify(payload), toolCalls: [], usage, finishReason: "stop" };
    }

    return { content: this.canned(messages), toolCalls: [], usage, finishReason: "stop" };
  }

  private canned(messages: LlmMessage[]): string {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "(no task text found)";
    const excerpt = lastUser.replace(/\s+/g, " ").trim().slice(0, 160);
    return (
      `[MOCK] This is a simulated response — no real LLM connection was used (--mock / ` +
      `DEVNULL_MOCK_LLM). Request excerpt: "${excerpt}${lastUser.length > 160 ? "…" : ""}". ` +
      `In mock mode every stage/phase completes in a single step with no tool calls, so this ` +
      `output demonstrates the pipeline mechanics (engine routing, the Validation Gate, health ` +
      `scoring, plan approval) without needing an API key or making a real network call.`
    );
  }
}


