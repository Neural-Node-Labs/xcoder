import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAMPLE_YAML = `# xcoder/agent/config/llm.yaml
# LLM backend configuration for the xcoder agent.
# Default backend: Ollama -- no API key needed.
provider: ollama
base_url: http://ollama:11434/v1
endpoint: /chat/completions
model: qwen2.5-coder:0.5b
api_key_env: OLLAMA_API_KEY
max_tokens: 4096
temperature: 0.0            # deterministic output for code/math tasks (this is a coding agent)
thinking: false              # qwen2.5-coder:0.5b has no separate thinking-mode API

overrides:
  rca:
    model: qwen2.5-coder:0.5b
  architect:
    model: qwen2.5-coder:0.5b

fallback:
  provider: ollama
  base_url: http://ollama:11434/v1
  model: qwen2.5-coder:0.5b
  api_key_env: OLLAMA_API_KEY
`;

let tmpHome: string;
let yamlPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "xcoder-llmconfig-"));
  const configDir = path.join(tmpHome, "agent", "config");
  fs.mkdirSync(configDir, { recursive: true });
  yamlPath = path.join(configDir, "llm.yaml");
  fs.writeFileSync(yamlPath, SAMPLE_YAML, "utf-8");
  process.env.XCODER_HOME = tmpHome;
});

afterEach(() => {
  delete process.env.XCODER_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("getLlmConfigSummary", () => {
  it("reads the current top-level provider settings", async () => {
    const { getLlmConfigSummary } = await import("../llmConfigStore.js");
    const summary = getLlmConfigSummary();
    expect(summary.provider).toBe("ollama");
    expect(summary.model).toBe("qwen2.5-coder:0.5b");
    expect(summary.base_url).toBe("http://ollama:11434/v1");
    expect(summary.max_tokens).toBe(4096);
    expect(summary.temperature).toBe(0);
    expect(summary.requiresNoAuth).toBe(true); // ollama is in NO_AUTH_PROVIDERS
  });

  it("reports requiresNoAuth: false for a provider that needs a key", async () => {
    fs.writeFileSync(yamlPath, SAMPLE_YAML.replace("provider: ollama", "provider: openai"), "utf-8");
    const { getLlmConfigSummary } = await import("../llmConfigStore.js");
    expect(getLlmConfigSummary().requiresNoAuth).toBe(false);
  });
});

describe("updateLlmConfig", () => {
  it("updates only the requested top-level keys, leaving comments and overrides/fallback untouched", async () => {
    const { updateLlmConfig } = await import("../llmConfigStore.js");
    const updated = updateLlmConfig({ provider: "openai", model: "gpt-5", api_key_env: "OPENAI_API_KEY" });

    expect(updated.provider).toBe("openai");
    expect(updated.model).toBe("gpt-5");
    expect(updated.api_key_env).toBe("OPENAI_API_KEY");

    const raw = fs.readFileSync(yamlPath, "utf-8");
    // comments and the overrides/fallback sections must survive byte-for-byte
    expect(raw).toContain("# xcoder/agent/config/llm.yaml");
    expect(raw).toContain("# deterministic output for code/math tasks");
    expect(raw).toContain("overrides:\n  rca:\n    model: qwen2.5-coder:0.5b");
    expect(raw).toContain("fallback:\n  provider: ollama");
    // and the untouched top-level keys must also survive unchanged
    expect(raw).toMatch(/^max_tokens: 4096$/m);
  });

  it("preserves a trailing inline comment on a line it edits", async () => {
    const { updateLlmConfig } = await import("../llmConfigStore.js");
    updateLlmConfig({ temperature: 0.7 });
    const raw = fs.readFileSync(yamlPath, "utf-8");
    expect(raw).toMatch(/^temperature: 0\.7\s+# deterministic output for code\/math tasks/m);
  });

  it("does not touch overrides.*.model even though it also matches the key name 'model'", async () => {
    const { updateLlmConfig } = await import("../llmConfigStore.js");
    updateLlmConfig({ model: "gpt-5" });
    const raw = fs.readFileSync(yamlPath, "utf-8");
    // top-level model changed...
    expect(raw).toMatch(/^model: gpt-5$/m);
    // ...but the indented overrides.rca.model / overrides.architect.model did not
    expect(raw).toContain("  rca:\n    model: qwen2.5-coder:0.5b");
    expect(raw).toContain("  architect:\n    model: qwen2.5-coder:0.5b");
  });

  it("appends a key that isn't present yet, right after the other top-level scalar keys", async () => {
    const withoutKeyEnv = SAMPLE_YAML.replace("api_key_env: OLLAMA_API_KEY\n", "");
    fs.writeFileSync(yamlPath, withoutKeyEnv, "utf-8");

    const { updateLlmConfig } = await import("../llmConfigStore.js");
    const updated = updateLlmConfig({ provider: "openai", api_key_env: "OPENAI_API_KEY" });
    expect(updated.api_key_env).toBe("OPENAI_API_KEY");

    const raw = fs.readFileSync(yamlPath, "utf-8");
    expect(raw).toMatch(/^api_key_env: OPENAI_API_KEY$/m);
    // still before the overrides section, not appended at the very end of the file
    expect(raw.indexOf("api_key_env: OPENAI_API_KEY")).toBeLessThan(raw.indexOf("overrides:"));
  });

  it("removes a key when explicitly set to an empty string", async () => {
    const { updateLlmConfig } = await import("../llmConfigStore.js");
    const updated = updateLlmConfig({ base_url: "" });
    expect(updated.base_url).toBeUndefined();
    const raw = fs.readFileSync(yamlPath, "utf-8");
    expect(raw).not.toMatch(/^base_url:/m);
  });

  it("throws a clear error if llm.yaml doesn't exist", async () => {
    fs.rmSync(yamlPath);
    const { updateLlmConfig } = await import("../llmConfigStore.js");
    expect(() => updateLlmConfig({ provider: "openai" })).toThrow(/No llm\.yaml found/);
  });
});

describe("KNOWN_PROVIDER_DEFAULTS / knownProviders", () => {
  it("includes ollama as a known provider with no api_key_env required", async () => {
    const { KNOWN_PROVIDER_DEFAULTS, knownProviders } = await import("../llmConfigStore.js");
    expect(knownProviders()).toContain("ollama");
    expect(KNOWN_PROVIDER_DEFAULTS.ollama.api_key_env).toBeUndefined();
    expect(KNOWN_PROVIDER_DEFAULTS.openai.api_key_env).toBe("OPENAI_API_KEY");
  });
});
