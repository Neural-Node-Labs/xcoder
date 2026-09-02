// ronin:version 9 | ronin:task task-d8bbc5 | ronin:updated 2026-08-13T07:27:46.471Z | ronin:subtask test-st-7dfd75
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DeepSeekClient, createLlmClient } from "../deepseekClient.js";
import {
  loadLlmConfig,
  resolveOpenAiBaseUrl,
  DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS,
  type LlmConfig,
} from "../../config/loadConfig.js";
import type { LlmMessage } from "../../core/types.js";
import fs from "node:fs";
import path from "node:path";

// ─── helpers ────────────────────────────────────────────────────────────────
let fetchMock: ReturnType<typeof vi.fn> | undefined;
let lastRequest: { url: string; init: RequestInit } | undefined;

function stubFetch(status: number, body: unknown): void {
  fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    lastRequest = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function makeConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "deepseek",
    base_url: "https://api.deepseek.com/v1",
    endpoint: "/chat/completions",
    model: "deepseek-v4-flash",
    api_key_env: "DEEPSEEK_API_KEY",
    max_tokens: 16384,
    temperature: 0.0,
    thinking: false,
    ...overrides,
  };
}

function bodyOf(): Record<string, unknown> {
  return JSON.parse(String(lastRequest?.init.body ?? "{}")) as Record<string, unknown>;
}

function headersOf(): Record<string, string> {
  return (lastRequest?.init.headers ?? {}) as Record<string, string>;
}

const defaultOpenAiBody = {
  choices: [
    {
      message: { content: "hello", tool_calls: [] },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const defaultAnthropicBody = {
  content: [{ type: "text", text: "hello" }],
  usage: { input_tokens: 1, output_tokens: 1 },
  stop_reason: "end_turn",
};

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  lastRequest = undefined;
  fetchMock = undefined;
  savedEnv.clear();
  for (const key of ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "ACME_API_KEY", "OPENAI_API_KEY"]) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
});

function messages(): LlmMessage[] {
  return [{ role: "user", content: "hi" }];
}

// ─── AC1: routing ───────────────────────────────────────────────────────────
describe("routing", () => {
  it("routes provider=anthropic to /v1/messages with x-api-key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    stubFetch(200, defaultAnthropicBody);
    const client = new DeepSeekClient(makeConfig({ provider: "anthropic", api_key_env: "ANTHROPIC_API_KEY" }));

    await client.complete(messages());

    expect(lastRequest?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(headersOf()["x-api-key"]).toBe("sk-ant-test");
    expect(headersOf()["anthropic-version"]).toBe("2023-06-01");
  });

  it("routes any other provider to base_url + endpoint with Bearer auth", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deep-test";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(makeConfig());

    await client.complete(messages());

    expect(lastRequest?.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(headersOf()["Authorization"]).toBe("Bearer sk-deep-test");
  });

  it("uses the known-provider registry when base_url is omitted", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(
      makeConfig({ provider: "openai", base_url: undefined, api_key_env: "OPENAI_API_KEY" })
    );

    await client.complete(messages());

    expect(resolveOpenAiBaseUrl({ provider: "openai" })).toBe("https://api.openai.com/v1");
    expect(lastRequest?.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("defaults endpoint to /chat/completions when base_url is present and endpoint is absent", async () => {
    process.env.ACME_API_KEY = "sk-acme";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(
      makeConfig({ provider: "acme", base_url: "https://api.acme.example/v1", endpoint: undefined, api_key_env: "ACME_API_KEY" })
    );

    await client.complete(messages());

    expect(lastRequest?.url).toBe("https://api.acme.example/v1/chat/completions");
  });
});

// ─── AC2: defaults ──────────────────────────────────────────────────────────
describe("defaults", () => {
  it("loadLlmConfig returns the DeepSeek default when no file exists", () => {
    const config = loadLlmConfig(path.join("definitely", "missing", "llm.yaml"));
    expect(config.provider).toBe("deepseek");
    expect(config.base_url).toBe("https://api.deepseek.com/v1");
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.api_key_env).toBe("DEEPSEEK_API_KEY");
  });

  it("shipped agent/config/llm.yaml sets provider: deepseek", () => {
    const content = fs.readFileSync("agent/config/llm.yaml", "utf-8");
    expect(content).toContain("provider: deepseek");
  });

  it("registry has the documented known providers with deepseek first", () => {
    expect(DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS["deepseek"]).toBe("https://api.deepseek.com/v1");
    expect(DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS["openai"]).toBe("https://api.openai.com/v1");
    expect(DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS["openrouter"]).toBe("https://openrouter.ai/api/v1");
    expect(DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS["groq"]).toBe("https://api.groq.com/openai/v1");
    expect(DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS["ollama"]).toBe("http://localhost:11434/v1");
  });
});

// ─── AC3: config-only switching ─────────────────────────────────────────────
describe("config-only switching", () => {
  it("calls a custom OpenAI-compatible provider exactly as configured", async () => {
    process.env.ACME_API_KEY = "sk-acme";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(
      makeConfig({
        provider: "acme",
        base_url: "https://api.acme.example/v1",
        endpoint: "/chat/completions",
        model: "acme-code",
        api_key_env: "ACME_API_KEY",
      })
    );

    await client.complete(messages());

    expect(lastRequest?.url).toBe("https://api.acme.example/v1/chat/completions");
    const b = bodyOf();
    expect(b["model"]).toBe("acme-code");
    expect(b["max_tokens"]).toBe(16384);
    expect(b["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });

  it("switches to Anthropic and sends the translated request shape", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    stubFetch(200, defaultAnthropicBody);
    const client = new DeepSeekClient(
      makeConfig({ provider: "anthropic", api_key_env: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-5" })
    );

    await client.complete([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);

    expect(lastRequest?.url).toBe("https://api.anthropic.com/v1/messages");
    const b = bodyOf();
    expect(b["model"]).toBe("claude-sonnet-4-5");
    expect(b["system"]).toBe("be terse");
    expect(b["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });
});

// ─── AC4: fallback ──────────────────────────────────────────────────────────
describe("fallback", () => {
  it("falls back when the primary key env is missing", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    stubFetch(200, defaultAnthropicBody);
    const client = new DeepSeekClient(
      makeConfig({ fallback: { provider: "anthropic", model: "claude-sonnet-4-5", api_key_env: "ANTHROPIC_API_KEY" } })
    );

    await client.complete(messages());

    expect(lastRequest?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("falls back when the primary call throws", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deep-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        throw new Error("primary exploded");
      })
      .mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
        lastRequest = { url: String(url), init: init ?? {} };
        return new Response(JSON.stringify(defaultAnthropicBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new DeepSeekClient(
      makeConfig({ fallback: { provider: "anthropic", model: "claude-sonnet-4-5", api_key_env: "ANTHROPIC_API_KEY" } })
    );

    const res = await client.complete(messages());

    expect(res.content).toBe("hello");
    expect(lastRequest?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("combines errors when both primary and fallback fail", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deep-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    fetchMock = vi.fn()
      .mockImplementationOnce(async () =>
        new Response("proxy html error", { status: 200, headers: { "content-type": "text/html" } })
      )
      .mockImplementationOnce(async () =>
        new Response("down", { status: 500, headers: { "content-type": "text/plain" } })
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new DeepSeekClient(
      makeConfig({ fallback: { provider: "anthropic", model: "claude-sonnet-4-5", api_key_env: "ANTHROPIC_API_KEY" } })
    );

    const err = await client.complete(messages()).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch("Primary LLM call failed");
    expect((err as Error).message).toMatch("Fallback provider anthropic also failed");
  });

  it("throws an explicit no-fallback error when no fallback is configured", async () => {
    const client = new DeepSeekClient(makeConfig({ fallback: undefined }));

    const err = await client.complete(messages()).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch("Primary LLM call failed");
    expect((err as Error).message).toMatch("no fallback provider configured");
  });
});

// ─── ollama / no-auth providers ──────────────────────────────────────────────
describe("ollama / no-auth providers", () => {
  it("calls a local ollama server with no API key and no Authorization header at all", async () => {
    // No DEEPSEEK_API_KEY, no OLLAMA_API_KEY, nothing — this is the whole point: a purely
    // local, unauthenticated provider must work with zero env vars set.
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(makeConfig({ provider: "ollama", base_url: undefined, api_key_env: undefined }));

    const res = await client.complete(messages());

    expect(res.content).toBe("hello");
    expect(lastRequest?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(headersOf()["Authorization"]).toBeUndefined();
    expect(Object.keys(headersOf())).not.toContain("Authorization");
  });

  it("still sends Authorization when an api_key_env IS provided for ollama (e.g. behind an authenticated proxy)", async () => {
    process.env.OLLAMA_API_KEY = "sk-ollama-proxy";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(makeConfig({ provider: "ollama", base_url: undefined, api_key_env: "OLLAMA_API_KEY" }));

    await client.complete(messages());

    expect(headersOf()["Authorization"]).toBe("Bearer sk-ollama-proxy");
  });

  it("does NOT fall back just because ollama has no api_key_env — it calls ollama directly", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test"; // fallback configured and available, but should be unused
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(
      makeConfig({
        provider: "ollama",
        base_url: undefined,
        api_key_env: undefined,
        fallback: { provider: "anthropic", model: "claude-sonnet-4-5", api_key_env: "ANTHROPIC_API_KEY" },
      })
    );

    await client.complete(messages());

    expect(lastRequest?.url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("still uses a fallback provider's own auth requirement when ollama is the fallback target and it also has no key", async () => {
    // Primary (deepseek) has no key -> falls back. Fallback provider is ollama, which needs
    // no key either -> the fallback call should succeed with no Authorization header.
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(
      makeConfig({ fallback: { provider: "ollama", model: "llama3", api_key_env: undefined } })
    );

    const res = await client.complete(messages());

    expect(res.content).toBe("hello");
    expect(lastRequest?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(headersOf()["Authorization"]).toBeUndefined();
  });

  it("respects an explicit custom base_url for ollama (e.g. a non-default port or remote host)", async () => {
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(
      makeConfig({ provider: "ollama", base_url: "http://192.168.1.50:11434/v1", api_key_env: undefined })
    );

    await client.complete(messages());

    expect(lastRequest?.url).toBe("http://192.168.1.50:11434/v1/chat/completions");
  });

  it("providerRequiresNoAuth() correctly identifies ollama and rejects other providers", async () => {
    const { providerRequiresNoAuth } = await import("../../config/loadConfig.js");
    expect(providerRequiresNoAuth("ollama")).toBe(true);
    expect(providerRequiresNoAuth("deepseek")).toBe(false);
    expect(providerRequiresNoAuth("anthropic")).toBe(false);
    expect(providerRequiresNoAuth("openai")).toBe(false);
  });

  it("non-no-auth providers still fall back (or error) when their api_key_env is missing, unaffected by the ollama exemption", async () => {
    const client = new DeepSeekClient(makeConfig({ provider: "deepseek", api_key_env: "DEEPSEEK_API_KEY", fallback: undefined }));

    const err = await client.complete(messages()).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch("missing DEEPSEEK_API_KEY");
  });
});

// ─── AC5: misconfiguration ──────────────────────────────────────────────────
describe("misconfiguration", () => {
  it("names the provider when base_url is missing for an unknown provider", async () => {
    process.env.BOGUS_API_KEY = "sk-bogus";
    const client = new DeepSeekClient(
      makeConfig({ provider: "bogus", base_url: undefined, api_key_env: "BOGUS_API_KEY" })
    );

    await expect(client.complete(messages())).rejects.toThrow(
      'provider "bogus" is missing base_url/endpoint in its config'
    );
  });

  it("names the fallback var when the fallback key is missing", async () => {
    const client = new DeepSeekClient(
      makeConfig({ fallback: { provider: "anthropic", model: "c1", api_key_env: "ANTHROPIC_API_KEY" } })
    );

    await expect(client.complete(messages())).rejects.toThrow("ANTHROPIC_API_KEY");
  });
});

// ─── AC7: backward-compat + factory ─────────────────────────────────────────
describe("backward compatibility", () => {
  it("createLlmClient returns a DeepSeekClient and still works", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deep-test";
    stubFetch(200, defaultOpenAiBody);
    const client = createLlmClient(makeConfig());
    expect(client).toBeInstanceOf(DeepSeekClient);

    const res = await client.complete(messages());
    expect(res.content).toBe("hello");
  });

  it("new DeepSeekClient(config) remains a valid entry point", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deep-test";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(makeConfig());

    const res = await client.complete(messages());
    expect(res.toolCalls).toEqual([]);
  });
});

// ─── AC8: DeepSeek thinking semantics ───────────────────────────────────────
describe("thinking semantics", () => {
  it("thinking=true sends enabled + reasoning_effort and omits temperature", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deep-test";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(makeConfig({ thinking: true, reasoning_effort: "high" }));

    await client.complete(messages());

    const b = bodyOf();
    expect(b["thinking"]).toEqual({ type: "enabled" });
    expect(b["reasoning_effort"]).toBe("high");
    expect(b).not.toHaveProperty("temperature");
  });

  it("thinking=false sends disabled explicitly and keeps temperature", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deep-test";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(makeConfig({ thinking: false, temperature: 0.2 }));

    await client.complete(messages());

    const b = bodyOf();
    expect(b["thinking"]).toEqual({ type: "disabled" });
    expect(b["temperature"]).toBe(0.2);
  });

  it("strips empty tool_calls arrays from outbound OpenAI-compatible messages", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deep-test";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(makeConfig());

    await client.complete([{ role: "assistant", content: "ok", tool_calls: [] }]);

    const b = bodyOf();
    expect(b["messages"]).toEqual([{ role: "assistant", content: "ok" }]);
  });
});

// ─── AC1b: known-provider registry routing + explicit base_url precedence ────
describe("known-provider registry routing", () => {
  it.each([
    ["openai", "https://api.openai.com/v1/chat/completions"],
    ["openrouter", "https://openrouter.ai/api/v1/chat/completions"],
    ["groq", "https://api.groq.com/openai/v1/chat/completions"],
    ["ollama", "http://localhost:11434/v1/chat/completions"],
  ])("routes provider=%s with no base_url via the registry", async (provider, expectedUrl) => {
    process.env.ACME_API_KEY = "sk-registry";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(
      makeConfig({ provider, base_url: undefined, api_key_env: "ACME_API_KEY" })
    );

    await client.complete(messages());

    expect(lastRequest?.url).toBe(expectedUrl);
    expect(headersOf()["Authorization"]).toBe("Bearer sk-registry");
  });

  it("explicit base_url wins over the known-provider registry", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deep-test";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(
      makeConfig({ base_url: "https://custom-proxy.example/v2", endpoint: "/completions" })
    );

    await client.complete(messages());

    expect(lastRequest?.url).toBe("https://custom-proxy.example/v2/completions");
  });

  it("falls back to the registry URL for a fallback provider with no fallback base_url", async () => {
    process.env.GROQ_API_KEY = "sk-groq";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(
      makeConfig({
        provider: "deepseek",
        fallback: { provider: "groq", model: "llama-3.3-70b", api_key_env: "GROQ_API_KEY" },
      })
    );

    await client.complete(messages());

    expect(lastRequest?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(bodyOf()["model"]).toBe("llama-3.3-70b");
  });
});

// ─── AC3b: response_format passthrough ───────────────────────────────────────
describe("response_format", () => {
  it("passes response_format json_object through to OpenAI-compatible providers", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deep-test";
    stubFetch(200, defaultOpenAiBody);
    const client = new DeepSeekClient(makeConfig());

    await client.complete(messages(), { responseFormat: "json_object" });

    expect(bodyOf()["response_format"]).toEqual({ type: "json_object" });
  });
});
