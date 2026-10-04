import { assertAllowance, recordTokens } from "./meter";
import { MODELS, LLM_MODE } from "./config";
import { span } from "./telemetry";
import { Tier } from "./types";
import { loadScenarios } from "../kernel/scenarios";

export interface LlmOut { text: string; tokens: number }
export interface LlmBackend { call(system: string, user: string, model: string, maxTokens: number): Promise<LlmOut> }

class AnthropicBackend implements LlmBackend {
  private key = process.env.ANTHROPIC_API_KEY ?? "";
  async call(system: string, user: string, model: string, maxTokens: number): Promise<LlmOut> {
    if (!this.key) throw new Error("ANTHROPIC_API_KEY not set");
    for (let attempt = 0; ; attempt++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
        signal: AbortSignal.timeout(120_000),
      });
      if ((r.status === 429 || r.status >= 500) && attempt < 3) { await new Promise((s) => setTimeout(s, 1500 * 2 ** attempt)); continue; }
      const j: any = await r.json();
      if (!r.ok) throw new Error(`anthropic ${r.status}: ${j?.error?.message ?? "error"}`);
      const text = (j.content ?? []).map((b: any) => b.text ?? "").join("");
      return { text, tokens: (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0) };
    }
  }
}

/** Offline stand-in. Solves the built-in eval scenarios via their 'oracle' commands so the whole
 *  pipeline (loop, policy, evals, evolution, promotion, rollback) can be tested with no API key. */
class MockBackend implements LlmBackend {
  private scenarios = loadScenarios();
  async call(system: string, user: string, _m: string, _t: number): Promise<LlmOut> {
    const role = /^ROLE:(\w+)/.exec(user)?.[1] ?? "unknown";
    const out = this.respond(role, user);
    return { text: JSON.stringify(out), tokens: 400 };
  }
  private respond(role: string, user: string): any {
    const goal = /TASK: ([\s\S]*?)\n(?:DEPENDENCY|EVIDENCE|RESULT)/.exec(user)?.[1]?.trim() ?? "";
    const msg = /MESSAGE: ([\s\S]*?)\n(?:HISTORY|MEMORY|$)/.exec(user)?.[1]?.trim() ?? "";
    switch (role) {
      case "planner":
        if (/^(hi|hello|hey)\b/i.test(msg)) return { answer: "Hello. Give me a DevOps task and I will do it in the sandbox." };
        return { tasks: [{ id: "t1", goal: msg, difficulty: "easy" }] };
      case "executor": {
        const step = Number(/STEP: (\d+)/.exec(user)?.[1] ?? 0);
        const sc = this.scenarios.find((s) => s.task === goal);
        if (sc) return step < sc.oracle.length ? { thought: "oracle", tool: "bash", args: { cmd: sc.oracle[step] } } : { final: "Done; verified by running the command output above." };
        return step === 0 ? { thought: "inspect", tool: "bash", args: { cmd: "echo '[mock llm] no API key configured'; ls -la" } }
                          : { final: "Mock mode: I only inspected the sandbox. Set LLM_MODE=anthropic for real work." };
      }
      case "critic": return { pass: true, issues: [] };
      case "synth": return { answer: "Completed (mock mode)." };
      case "reflect": return { lesson: "Inspect first, apply the smallest fix, verify with a command." };
      case "simulate": return { predicted: "Modifies files inside the sandbox only.", risk: "medium", reversible: true };
      case "skill": return { save: false };
      case "evolve": {
        const cur = Number(/"memoryTopK":\s*(\d+)/.exec(user)?.[1] ?? 3);
        return { rationale: "Mock: widen memory recall by one item.", changes: { params: { memoryTopK: cur >= 8 ? 3 : cur + 1 } } };
      }
      default: return {};
    }
  }
}

export function parseJson(text: string): any {
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        try { return JSON.parse(text.slice(i, j + 1)); } catch { break; }
      }
    }
  }
  return {};
}

export class LlmClient {
  backend: LlmBackend = LLM_MODE === "anthropic" ? new AnthropicBackend() : new MockBackend();
  /** Router: tier -> model. Returns parsed JSON plus tokens used. */
  async ask(role: string, system: string, user: string, tier: Tier): Promise<{ json: any; tokens: number }> {
    const model = MODELS[tier];
    return span("llm.call", { "gen_ai.request.model": model, "llm.role": role, "llm.tier": tier }, async (s) => {
      assertAllowance();   // scheduler-started work stops once the daily allowance is spent
      const body = `ROLE:${role}\n${user}`;
      let r = await this.backend.call(system, body, model, role === "executor" ? 3000 : 2000);
      let json = parseJson(r.text);
      let tokens = r.tokens;
      if (!Object.keys(json).length) {
        r = await this.backend.call(system, body + "\n\nYour last reply was not valid JSON. Reply with ONE valid JSON object only.", model, 2000);
        json = parseJson(r.text); tokens += r.tokens;
      }
      s.setAttribute("gen_ai.usage.total_tokens", tokens);
      recordTokens(tokens);
      return { json, tokens };
    });
  }
}
