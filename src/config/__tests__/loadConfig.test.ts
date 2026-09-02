// ronin:version 1 | ronin:task task-d8bbc5 | ronin:updated 2026-08-13T07:27:39.800Z | ronin:subtask test-st-7dfd75
// ronin:task task-d8bbc5 | ronin:subtask test-st-7dfd75
import { describe, it, expect } from "vitest";
import {
  DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URLS,
  resolveOpenAiBaseUrl,
  resolveOpenAiEndpoint,
  loadLlmConfig,
  resolveModelForSkill,
  type LlmConfig,
} from "../loadConfig.js";

function fullConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
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

describe("DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS", () => {
  it("registers the documented OpenAI-compatible provider URLs", () => {
    expect(DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS).toEqual({
      deepseek: "https://api.deepseek.com/v1",
      openai: "https://api.openai.com/v1",
      openrouter: "https://openrouter.ai/api/v1",
      groq: "https://api.groq.com/openai/v1",
      ollama: "http://localhost:11434/v1",
    });
  });

  it("exposes the backward-compatible alias to the same registry object", () => {
    expect(DEFAULT_OPENAI_COMPATIBLE_BASE_URLS).toBe(DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS);
  });
});

describe("resolveOpenAiBaseUrl", () => {
  it("prefers an explicit base_url over the known-provider registry", () => {
    expect(resolveOpenAiBaseUrl({ provider: "deepseek", base_url: "https://proxy.example/v1" })).toBe(
      "https://proxy.example/v1"
    );
  });

  it("falls back to the registry when base_url is absent for a known provider", () => {
    expect(resolveOpenAiBaseUrl({ provider: "openai" })).toBe("https://api.openai.com/v1");
    expect(resolveOpenAiBaseUrl({ provider: "openrouter" })).toBe("https://openrouter.ai/api/v1");
    expect(resolveOpenAiBaseUrl({ provider: "groq" })).toBe("https://api.groq.com/openai/v1");
    expect(resolveOpenAiBaseUrl({ provider: "ollama" })).toBe("http://localhost:11434/v1");
  });

  it("returns undefined for unknown providers with no explicit base_url", () => {
    expect(resolveOpenAiBaseUrl({ provider: "acme-corp" })).toBeUndefined();
  });

  it("returns undefined when both provider and base_url are absent", () => {
    expect(resolveOpenAiBaseUrl({ provider: "" })).toBeUndefined();
  });
});

describe("resolveOpenAiEndpoint", () => {
  it("defaults to /chat/completions when endpoint is absent", () => {
    expect(resolveOpenAiEndpoint({})).toBe("/chat/completions");
  });

  it("honors an explicitly configured endpoint", () => {
    expect(resolveOpenAiEndpoint({ endpoint: "/v1/chat/completions" })).toBe("/v1/chat/completions");
  });

  it("does not throw when passed a no-endpoint pick-type", () => {
    expect(resolveOpenAiEndpoint({ endpoint: undefined })).toBe("/chat/completions");
  });
});

describe("NO_AUTH_PROVIDERS / providerRequiresNoAuth", () => {
  it("registers ollama as the only current no-auth provider", async () => {
    const { NO_AUTH_PROVIDERS } = await import("../loadConfig.js");
    expect(NO_AUTH_PROVIDERS.has("ollama")).toBe(true);
    expect(NO_AUTH_PROVIDERS.size).toBe(1);
  });

  it("providerRequiresNoAuth distinguishes ollama from every other provider", async () => {
    const { providerRequiresNoAuth } = await import("../loadConfig.js");
    expect(providerRequiresNoAuth("ollama")).toBe(true);
    for (const p of ["deepseek", "anthropic", "openai", "openrouter", "groq", "acme-corp"]) {
      expect(providerRequiresNoAuth(p)).toBe(false);
    }
  });
});

describe("validateFallbackConfig", () => {
  it("returns no errors when no fallback is configured", async () => {
    const { validateFallbackConfig } = await import("../loadConfig.js");
    expect(validateFallbackConfig(fullConfig({ fallback: undefined }))).toEqual([]);
  });

  it("requires api_key_env for a normal fallback provider", async () => {
    const { validateFallbackConfig } = await import("../loadConfig.js");
    const errors = validateFallbackConfig(
      fullConfig({ fallback: { provider: "anthropic", model: "claude-sonnet-4-5", api_key_env: undefined } })
    );
    expect(errors).toContain("Missing or empty fallback.api_key_env");
  });

  it("does NOT require api_key_env when the fallback provider is ollama", async () => {
    const { validateFallbackConfig } = await import("../loadConfig.js");
    const errors = validateFallbackConfig(
      fullConfig({ fallback: { provider: "ollama", model: "llama3", api_key_env: undefined } })
    );
    expect(errors).not.toContain("Missing or empty fallback.api_key_env");
    expect(errors).toEqual([]);
  });

  it("still validates the referenced env var exists when ollama's api_key_env IS set", async () => {
    const { validateFallbackConfig } = await import("../loadConfig.js");
    delete process.env.OLLAMA_PROXY_KEY;
    const errors = validateFallbackConfig(
      fullConfig({ fallback: { provider: "ollama", model: "llama3", api_key_env: "OLLAMA_PROXY_KEY" } })
    );
    expect(errors).toContain("Environment variable specified in fallback.api_key_env (OLLAMA_PROXY_KEY) is unset or empty");
  });

  it("flags a missing fallback.provider and fallback.model regardless of provider", async () => {
    const { validateFallbackConfig } = await import("../loadConfig.js");
    const errors = validateFallbackConfig(
      fullConfig({ fallback: { provider: "", model: "", api_key_env: undefined } })
    );
    expect(errors).toContain("Missing or empty fallback.provider");
    expect(errors).toContain("Missing or empty fallback.model");
  });

  it("requires base_url resolution for a non-anthropic, non-registry fallback provider", async () => {
    const { validateFallbackConfig } = await import("../loadConfig.js");
    const errors = validateFallbackConfig(
      fullConfig({ fallback: { provider: "acme-corp", model: "acme-1", api_key_env: undefined } })
    );
    expect(errors.some((e) => e.includes("fallback.base_url is required"))).toBe(true);
  });
});

describe("loadLlmConfig", () => {
  it("returns the complete DeepSeek default config when no config file exists", () => {
    const config = loadLlmConfig("definitely/does-not-exist/llm.yaml");
    expect(config).toMatchObject({
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      endpoint: "/chat/completions",
      model: "deepseek-v4-flash",
      api_key_env: "DEEPSEEK_API_KEY",
      max_tokens: 16384,
      temperature: 0.0,
      thinking: false,
    });
    expect(config.fallback).toBeUndefined();
    expect(config.overrides).toBeUndefined();
  });
});

describe("resolveModelForSkill", () => {
  it("applies a full per-skill override without mutating the base config", () => {
    const config = fullConfig({
      overrides: {
        rca: { model: "deepseek-v4-pro", thinking: true, reasoning_effort: "high" },
      },
    });

    expect(resolveModelForSkill(config, "rca")).toEqual({
      model: "deepseek-v4-pro",
      temperature: 0.0,
      thinking: true,
      reasoningEffort: "high",
    });
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.thinking).toBe(false);
  });

  it("uses base config values for a skill with no override", () => {
    const config = fullConfig({ thinking: true, reasoning_effort: "max" });
    expect(resolveModelForSkill(config, "architect")).toEqual({
      model: "deepseek-v4-flash",
      temperature: 0.0,
      thinking: true,
      reasoningEffort: "max",
    });
  });

  it("applies partial overrides field-by-field instead of wholesale", () => {
    const config = fullConfig({
      overrides: {
        audit: { temperature: 0.7 },
      },
    });
    expect(resolveModelForSkill(config, "audit")).toEqual({
      model: "deepseek-v4-flash",
      temperature: 0.7,
      thinking: false,
      reasoningEffort: undefined,
    });
  });

  it("returns base values when skillName is undefined", () => {
    const config = fullConfig({ overrides: { rca: { model: "deepseek-v4-pro" } } });
    expect(resolveModelForSkill(config)).toEqual({
      model: "deepseek-v4-flash",
      temperature: 0.0,
      thinking: false,
      reasoningEffort: undefined,
    });
  });
});
