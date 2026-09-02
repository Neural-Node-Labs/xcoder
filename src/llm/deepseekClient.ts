// ronin:version 6 | ronin:task task-d8bbc5 | ronin:updated 2026-08-13T07:33:07.199Z | ronin:subtask test-st-7dfd75
import { LlmClient, LlmMessage, LlmResponse, ToolSchema } from "../core/types.js";
import {
  LlmConfig,
  resolveModelForSkill,
  resolveOpenAiBaseUrl,
  resolveOpenAiEndpoint,
  providerRequiresNoAuth,
  DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS,
} from "../config/loadConfig.js";
import { TelemetryInterface } from "../core/types.js";
import { AutoMockLlmClient } from "./mockClient.js";

/**
 * Pinanatili ang pangalan ng klase bilang DeepSeekClient para sa backward compatibility sa mga
 * umiiral nang import (CLI, API routes, tests) kahit na generic na provider-routing client na
 * ito ngayon — ang DeepSeek ang default backend ng xcoder, pero ang `config.provider` (at ang
 * `config.fallback.provider`) ang tumutukoy kung aling shape ang talagang gagamitin para sa
 * primary call AT sa fallback, kaya ang alinman sa dalawa ay maaaring DeepSeek, Anthropic, o
 * mapagpalit sa pagitan ng dalawa sa pamamagitan lamang ng llm.yaml nang walang pagbabago sa code.
 */
export class DeepSeekClient implements LlmClient {
  constructor(
    private config: LlmConfig,
    private telemetry?: TelemetryInterface,
    private skillName?: string
  ) {}

  async complete(
    messages: LlmMessage[],
    opts?: { model?: string; temperature?: number; tools?: ToolSchema[]; responseFormat?: "json_object" }
  ): Promise<LlmResponse> {
    const resolved = resolveModelForSkill(this.config, this.skillName);
    const model = opts?.model ?? resolved.model;
    const apiKey = this.config.api_key_env ? process.env[this.config.api_key_env] : undefined;
    const noAuthOk = providerRequiresNoAuth(this.config.provider);

    // Para sa karamihan ng provider, required ang isang tunay na API key -- kung wala ito,
    // ituring itong bilang isang kabiguan at agad tumawid sa fallback (kung na-configure).
    // Para sa mga lokal, unauthenticated na provider (ollama), sadyang HINDI ito humihinto:
    // walang laman na apiKey ay tumpak na inaasahang kondisyon, hindi isang error.
    if (!apiKey && !noAuthOk) {
      return this.fallback(messages, opts, `missing ${this.config.api_key_env ?? "api_key_env"}`);
    }

    try {
      if (this.config.provider === "anthropic") {
        return await this.callAnthropic(model, apiKey ?? "", messages, this.config, opts);
      }
      return await this.callOpenAiCompatible(model, apiKey, messages, this.config, resolved, opts, "DeepSeekClient");
    } catch (err) {
      await this.telemetry?.logError(err, "DeepSeekClient");
      return this.fallback(messages, opts, err instanceof Error ? err.message : "request failed");
    }
  }

  /** OpenAI-compatible /chat/completions shape — ginagamit para sa DeepSeek at anumang
   *  OpenAI-compatible provider na naka-configure gamit ang base_url + endpoint. Opsyonal ang
   *  `apiKey` para sa mga lokal, unauthenticated na provider (ollama) -- kapag walang laman,
   *  hindi ipinapadala ang Authorization header sa halip na magpadala ng "Bearer undefined". */
  private async callOpenAiCompatible(
    model: string,
    apiKey: string | undefined,
    messages: LlmMessage[],
    config: LlmConfig,
    resolved: ReturnType<typeof resolveModelForSkill>,
    opts: { tools?: ToolSchema[]; temperature?: number; responseFormat?: "json_object" } | undefined,
    telemetrySource: string
  ): Promise<LlmResponse> {
    const baseUrl = resolveOpenAiBaseUrl(config) ?? config.base_url;
    if (!baseUrl) {
      throw new Error(`provider "${config.provider}" is missing base_url/endpoint in its config`);
    }
    const url = `${baseUrl}${resolveOpenAiEndpoint(config)}`;

    // Ayon sa Thinking Mode docs ng DeepSeek: WALANG EPEKTO ang temperature/top_p/
    // presence_penalty/frequency_penalty sa thinking mode (tahimik na hindi pinapansin, hindi
    // error) -- kaya alisin ang mga ito sa halip na magpadala ng mga patay na parameter.
    // Ang reasoning_effort ang tunay na kontrol doon. Ang field na `thinking` mismo ay laging
    // ipinapadala nang tahasan (hindi kailanman inaalis) para hindi umasa ang behavior sa
    // default ng isang model, na maaaring iba-iba sa bawat tier.
    const samplingParams = resolved.thinking ? {} : { temperature: opts?.temperature ?? resolved.temperature };
    const thinkingParams = resolved.thinking
      ? { thinking: { type: "enabled" }, ...(resolved.reasoningEffort ? { reasoning_effort: resolved.reasoningEffort } : {}) }
      : { thinking: { type: "disabled" } };

    const body = {
      model,
      max_tokens: config.max_tokens,
      messages: messages.map(stripUndefined),
      ...samplingParams,
      ...thinkingParams,
      ...(opts?.tools ? { tools: opts.tools, tool_choice: "auto" } : {}),
      ...(opts?.responseFormat ? { response_format: { type: opts.responseFormat } } : {}),
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${config.provider} HTTP ${res.status}: ${text}`);
    }

    // Bantayan ang mga non-JSON na tugon (hal. proxy HTML error pages na nagbabalik ng 200)
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json") && !contentType.includes("text/event-stream")) {
      const text = await res.text();
      throw new Error(
        `${config.provider} returned non-JSON response (Content-Type: ${contentType}): ${text.slice(0, 500)}`
      );
    }

    const data = (await res.json()) as {
      choices: {
        message: { content: string | null; tool_calls?: LlmResponse["toolCalls"]; reasoning_content?: string };
        finish_reason?: string;
      }[];
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_cache_hit_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const message = data.choices?.[0]?.message;
    await this.telemetry?.logLlmCall(body, data);
    return {
      content: message?.content ?? "",
      toolCalls: message?.tool_calls ?? [],
      reasoningContent: message?.reasoning_content,
      finishReason: data.choices?.[0]?.finish_reason,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
            reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens,
            cachedTokens: data.usage.prompt_cache_hit_tokens,
          }
        : undefined,
    };
  }

  /** Anthropic /v1/messages shape, kabilang na ang tunay na tool-calling — isinasalin ang mga
   *  OpenAI-shaped na mensahe/tools papunta sa format ng Anthropic at ang tool_use content
   *  blocks pabalik sa ToolCall[]. Hindi ito opsyonal: ang ReAct loop ay ganap na pinapatakbo
   *  ng tool_calls, kaya ang isang text-only Anthropic integration ay gagawing hindi
   *  magagamit ang agent bilang primary (isang text reply, tapos titigil na lang ito dahil
   *  agad na nagtatapos ang loop kapag response.toolCalls.length === 0). */
  private async callAnthropic(
    model: string,
    apiKey: string,
    messages: LlmMessage[],
    config: LlmConfig,
    opts?: { tools?: ToolSchema[]; responseFormat?: "json_object" }
  ): Promise<LlmResponse> {
    const { system, anthropicMessages } = convertMessagesToAnthropic(messages);
    const anthropicTools = convertToolsToAnthropic(opts?.tools);

    const body: Record<string, unknown> = {
      model,
      max_tokens: config.max_tokens,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(anthropicTools ? { tools: anthropicTools } : {}),
    };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`anthropic HTTP ${res.status}: ${text}`);
    }

    // Bantayan ang mga non-JSON na tugon (hal. proxy HTML error pages na nagbabalik ng 200)
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = await res.text();
      throw new Error(
        `anthropic returned non-JSON response (Content-Type: ${contentType}): ${text.slice(0, 500)}`
      );
    }

    const data = (await res.json()) as {
      content: AnthropicContentBlock[];
      usage?: { input_tokens: number; output_tokens: number };
      stop_reason?: string;
    };
    await this.telemetry?.logLlmCall(body, data);

    const textBlocks = data.content?.filter((b): b is { type: "text"; text: string } => b.type === "text") ?? [];
    const toolUseBlocks = data.content?.filter((b): b is AnthropicToolUseBlock => b.type === "tool_use") ?? [];

    return {
      content: textBlocks.map((b) => b.text).join("\n"),
      toolCalls: toolUseBlocks.map((b) => ({
        id: b.id,
        type: "function" as const,
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      })),
      finishReason: data.stop_reason === "max_tokens" ? "length" : data.stop_reason,
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
    };
  }

  private async fallback(
    messages: LlmMessage[],
    opts: { model?: string; temperature?: number; tools?: ToolSchema[]; responseFormat?: "json_object" } | undefined,
    reason: string
  ): Promise<LlmResponse> {
    if (!this.config.fallback) {
      throw new Error(`Primary LLM call failed (${reason}) and no fallback provider configured.`);
    }
    await this.telemetry?.logError(new Error(`Falling back: ${reason}`), "DeepSeekClient.fallback");

    const { provider, model, api_key_env } = this.config.fallback;
    const apiKey = api_key_env ? process.env[api_key_env] : undefined;
    const noAuthOk = providerRequiresNoAuth(provider);
    if (!apiKey && !noAuthOk) {
      // Ipakita muna ang tunay na error (ang pangunahing dahilan ng kabiguan), pagkatapos
      // banggitin ang fallback bilang pangalawang konteksto. Isama ang request payload
      // para sa kumpletong diagnostics.
      const payload = {
        model: this.config.model,
        max_tokens: this.config.max_tokens,
        messageCount: messages.length,
        lastMessageRole: messages[messages.length - 1]?.role,
        lastMessagePreview: messages[messages.length - 1]?.content?.slice(0, 200),
      };
      throw new Error(
        `Primary LLM call failed: ${reason}. ` +
          `Fallback provider ${provider} also unavailable (missing ${api_key_env ?? "api_key_env"}). ` +
          `Request payload: ${JSON.stringify(payload)}`
      );
    }

    try {
      if (provider === "anthropic") {
        return await this.callAnthropic(model, apiKey ?? "", messages, this.config, opts);
      }
      const fallbackBaseUrl = this.config.fallback.base_url ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URLS[provider];
      if (fallbackBaseUrl) {
        // Anumang OpenAI-compatible fallback (DeepSeek man o iba pa), basta't malulutas ang
        // base URL mula sa tahasang fallback.base_url o sa registry ng kilalang provider
        // — muling ginagamit ang eksaktong resolveModelForSkill-shaped na default gaya ng
        // primary, pero iniiwan ang sariling model/temperature/thinking ng fallback sa mga
        // default ng config (walang per-skill overrides na inilalapat sa fallback provider).
        const fallbackConfig: LlmConfig = {
          ...this.config,
          provider,
          model,
          api_key_env,
          base_url: fallbackBaseUrl,
          endpoint: this.config.fallback.endpoint ?? "/chat/completions",
        };

        const resolved = { model, temperature: this.config.temperature, thinking: false, reasoningEffort: undefined };
        return await this.callOpenAiCompatible(model, apiKey, messages, fallbackConfig, resolved, opts, "DeepSeekClient.fallback");
      }
      throw new Error(`Unsupported fallback provider: ${provider} (no base_url and not a known provider)`);
    } catch (err) {
      throw new Error(
        `Primary LLM call failed: ${reason}. Fallback provider ${provider} also failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Inirerekomendang construction seam para sa mga LLM client. Sa kasalukuyan ay laging
 * nagbabalik ng DeepSeekClient (na nagru-route papunta sa Anthropic o kahit anong
 * OpenAI-compatible provider batay sa config), pero nagbibigay sa mga caller ng matatag na
 * factory na maaaring gamitin kung sakaling kailanganin ang provider-specific na client.
 *
 * `opts.mock: true` (o ang XCODER_MOCK_LLM=1/true env var, kapag hindi tahasang ibinigay ang
 * `opts.mock`) ay nagbabalik ng AutoMockLlmClient sa halip — WALANG tunay na koneksyon sa
 * network, WALANG kailangang api_key_env, gumagana sa alinmang gawain nang walang scripting.
 * Ito ang tanging lugar kung saan dapat mag-branch ang mock-vs-real na desisyon; ang lahat ng
 * caller (cli/index.ts, api/routes.ts) ay dapat dumaan dito sa halip na direktang gumawa ng
 * `new DeepSeekClient(...)`, para hindi kailanman mag-drift ang dalawang landas na ito.
 */
export function createLlmClient(
  config: LlmConfig,
  telemetry?: TelemetryInterface,
  skillName?: string,
  opts?: { mock?: boolean }
): LlmClient {
  const mock = opts?.mock ?? /^(1|true)$/i.test(process.env.XCODER_MOCK_LLM ?? "");
  if (mock) return new AutoMockLlmClient();
  return new DeepSeekClient(config, telemetry, skillName);
}

/** Backward-compatible alias: nasa src/config/loadConfig.ts na ngayon ang tunay na registry
 *  (DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS) para pareho ang pinaniniwalaan ng client at ng
 *  config layer. */
const DEFAULT_OPENAI_COMPATIBLE_BASE_URLS = DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS;

function stripUndefinedOrig(message: LlmMessage): LlmMessage {
  return Object.fromEntries(Object.entries(message).filter(([, v]) => v !== undefined)) as LlmMessage;
}

function stripUndefined(message: LlmMessage): LlmMessage {
  return Object.fromEntries(
    Object.entries(message).filter(([k, v]) => {
      // Alisin ang mga tahasang undefined na value
      if (v === undefined) return false;

      // Alisin ang mga walang-laman na tool_calls array para maiwasan ang API validation errors
      if (k === 'tool_calls' && Array.isArray(v) && v.length === 0) return false;

      return true;
    })
  ) as LlmMessage;
}


// ─── Pagsasalin ng mensahe/tool sa pagitan ng Anthropic at OpenAI-shaped ──────────────────
//
// Sa lahat ng ibang bahagi ng codebase (orchestrator.ts, toolDispatcher.ts, types.ts) ay
// gumagamit ng OpenAI chat-completions shape: may dalang `tool_calls` ang mga assistant
// message, at hiwalay na `role: "tool"` na mensahe na may `tool_call_id` ang mga resulta ng
// tool. Iba ang shape ng Messages API ng Anthropic: nasa loob ng `content` array ng isang
// assistant message ang tool_use, at bumabalik ang mga resulta bilang `role: "user"` na
// mensahe na may `tool_result` content blocks (karaniwang naka-batch -- lahat ng tool_results
// na sumasagot sa isang assistant turn ay dapat nasa iisang user message, hindi isa-isa).
// Ang dalawang function na ito lamang ang lugar kung saan nangyayari ang pagsasaling ito, kaya
// walang kailangang malaman o pakialaman kung aling provider ang talagang tinatawag.

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | AnthropicToolUseBlock
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

function convertMessagesToAnthropic(messages: LlmMessage[]): { system?: string; anthropicMessages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const result: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) systemParts.push(m.content);
      continue;
    }

    if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: safeParseArgs(call.function.arguments),
        });
      }
      // Ang isang assistant turn na walang laman (hindi dapat mangyari sa karaniwan) ay
      // kailangan pa ring may laman — tinatanggihan ng Anthropic ang mga walang-lamang content array.
      result.push({ role: "assistant", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] });
      continue;
    }

    if (m.role === "tool") {
      const resultBlock: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: m.content ?? "",
      };
      // I-batch ang magkakasunod na tool results sa iisang user message, ayon sa inaasahan
      // ng Anthropic na dapat magkasama ang lahat ng tool_results para sa isang assistant turn.
      const prev = result[result.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content) && prev.content.every((b) => b.type === "tool_result")) {
        prev.content.push(resultBlock);
      } else {
        result.push({ role: "user", content: [resultBlock] });
      }
      continue;
    }

    // ordinaryong user message
    result.push({ role: "user", content: m.content ?? "" });
  }

  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, anthropicMessages: result };
}

function convertToolsToAnthropic(tools?: ToolSchema[]): { name: string; description: string; input_schema: unknown }[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

function safeParseArgs(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

