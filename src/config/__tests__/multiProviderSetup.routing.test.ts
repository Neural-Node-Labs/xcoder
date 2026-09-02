// ronin:version 2 | ronin:task task-b5feec | ronin:updated 2026-08-13T08:30:04.771Z | ronin:subtask test-st-eb7b20
// ronin:task task-b5feec | ronin:subtask test-st-eb7b20
//
// Intended-behavior tests for the executable multi-provider routing contract.
// The documented contract (README + docs/en/setup.md + agent/config/llm.yaml):
//   1. DeepSeek is the default provider.
//   2. An explicit base_url always wins over the built-in provider URL registry.
//   3. When base_url is omitted, the registry entry for
//      deepseek/openai/openrouter/groq/ollama is used.
//   4. endpoint defaults to /chat/completions when omitted.
//   5. api_key_env names the environment variable holding the key; keys are never
//      inlined in YAML.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import {
  DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS,
  resolveOpenAiBaseUrl,
  resolveOpenAiEndpoint,
  loadLlmConfig,
  type LlmConfig,
} from "../loadConfig.js";

const ROOT = process.cwd();
const LLM_YAML = path.join(ROOT, "agent", "config", "llm.yaml");

describe("multi-provider routing contract (loadConfig)", () => {
  it("registers the exact documented provider URL registry", () => {
    expect(DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS).toEqual({
      deepseek: "https://api.deepseek.com/v1",
      openai: "https://api.openai.com/v1",
      openrouter: "https://openrouter.ai/api/v1",
      groq: "https://api.groq.com/openai/v1",
      ollama: "http://localhost:11434/v1",
    });
  });

  it("an explicit base_url always wins for every known provider", () => {
    for (const provider of Object.keys(DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS)) {
      expect(resolveOpenAiBaseUrl({ provider, base_url: "https://proxy.example/v1" })).toBe("https://proxy.example/v1");
      // Anthropic is not OpenAI-compatible: it must never resolve through the registry.
      expect(resolveOpenAiBaseUrl({ provider: "anthropic" })).toBeUndefined();
    }
  });

  it("known providers work from the registry when base_url is omitted", () => {
    expect(resolveOpenAiBaseUrl({ provider: "deepseek" })).toBe("https://api.deepseek.com/v1");
    expect(resolveOpenAiBaseUrl({ provider: "openai" })).toBe("https://api.openai.com/v1");
    expect(resolveOpenAiBaseUrl({ provider: "openrouter" })).toBe("https://openrouter.ai/api/v1");
    expect(resolveOpenAiBaseUrl({ provider: "groq" })).toBe("https://api.groq.com/openai/v1");
    expect(resolveOpenAiBaseUrl({ provider: "ollama" })).toBe("http://localhost:11434/v1");
  });

  it("custom providers require an explicit base_url (misconfiguration surfaces as undefined)", () => {
    expect(resolveOpenAiBaseUrl({ provider: "my-company-proxy" })).toBeUndefined();
    expect(resolveOpenAiBaseUrl({ provider: "my-company-proxy", base_url: "https://llm.gateway.example.com/v1" })).toBe("https://llm.gateway.example.com/v1");
  });

  it("endpoint defaults to /chat/completions when omitted", () => {
    expect(resolveOpenAiEndpoint({})).toBe("/chat/completions");
    expect(resolveOpenAiEndpoint({ endpoint: "/v1/chat/completions" })).toBe("/v1/chat/completions");
  });

  it("missing config file falls back to the documented DeepSeek default with api_key_env", () => {
    const config = loadLlmConfig(path.join(ROOT, "does", "not", "exist", "llm.yaml"));
    expect(config.provider).toBe("deepseek");
    expect(config.base_url).toBe("https://api.deepseek.com/v1");
    expect(config.endpoint).toBe("/chat/completions");
    expect(config.api_key_env).toBe("DEEPSEEK_API_KEY");
  });

  it("the shipped agent/config/llm.yaml is a valid config and keeps DeepSeek as default", () => {
    const doc = yaml.load(readFileSync(LLM_YAML, "utf-8")) as LlmConfig;
    expect(doc.provider).toBe("deepseek");
    expect(doc.api_key_env).toBe("DEEPSEEK_API_KEY");
    expect(doc.base_url).toBe("https://api.deepseek.com/v1");
    expect(doc.model).toMatch(/^deepseek-v4-/);
    expect(doc.fallback?.provider).toBe("deepseek");
    expect(doc.fallback?.api_key_env).toBe("DEEPSEEK_API_KEY");
  });

  it("the config never inlines keys (API keys live in env vars named by api_key_env)", () => {
    const raw = readFileSync(LLM_YAML, "utf-8");
    // Word-boundary guard: the ronin header contains `task-d8bbc5`, which would
    // false-positive on a naive `sk-\S+` pattern. Real inline keys look like
    // `sk-your-key-here` / `sk-ant-...`.
    expect(raw).not.toMatch(/\bsk-[A-Za-z0-9/._-]+/);
    expect(raw.match(/api_key_env:\s*(\S+)/)).not.toBeNull();
    expect(raw).toMatch(/api_key_env:\s*\S+/);
  });
});
