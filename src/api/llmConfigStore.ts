import fs from "node:fs";
import path from "node:path";
import {
  loadLlmConfig,
  resolveConfigPath,
  providerRequiresNoAuth,
  DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS,
  LlmConfig,
} from "../config/loadConfig.js";

/**
 * Backs the Settings page's "LLM provider" picker. Reads/writes only the top-level scalar keys
 * of agent/config/llm.yaml (provider, base_url, endpoint, model, api_key_env, max_tokens,
 * temperature) — never touches `overrides`/`fallback`, and never rewrites the file through
 * js-yaml's dump(), which would silently strip every one of the file's extensive explanatory
 * comments. Instead this does a targeted, line-by-line find-and-replace (or append, for a key
 * that isn't present yet) of just those top-level keys, leaving everything else — comments,
 * indentation, `overrides`, `fallback` — byte-for-byte untouched.
 *
 * "Top-level" here specifically means unindented (column 0) `key:` lines, so this can't be
 * fooled by e.g. `overrides.rca.model:` (which is indented) into editing the wrong thing.
 */

export const KNOWN_PROVIDER_DEFAULTS: Record<string, { base_url?: string; model: string; api_key_env?: string }> = {
  ollama: { base_url: DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS.ollama, model: "granite4:1b" },
  openai: { base_url: DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS.openai, model: "gpt-5", api_key_env: "OPENAI_API_KEY" },
  anthropic: { model: "claude-sonnet-4-5", api_key_env: "ANTHROPIC_API_KEY" },
  deepseek: { base_url: DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS.deepseek, model: "deepseek-v4-flash", api_key_env: "DEEPSEEK_API_KEY" },
  openrouter: { base_url: DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS.openrouter, model: "anthropic/claude-sonnet-4-5", api_key_env: "OPENROUTER_API_KEY" },
  groq: { base_url: DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS.groq, model: "llama-3.3-70b-versatile", api_key_env: "GROQ_API_KEY" },
};

function llmConfigYamlPath(): string {
  return path.join(resolveConfigPath(), "config", "llm.yaml");
}

export interface LlmConfigSummary {
  provider: string;
  base_url?: string;
  endpoint?: string;
  model: string;
  api_key_env?: string;
  max_tokens: number;
  temperature: number;
  requiresNoAuth: boolean;
}

export function getLlmConfigSummary(): LlmConfigSummary {
  const config = loadLlmConfig();
  return {
    provider: config.provider,
    base_url: config.base_url,
    endpoint: config.endpoint,
    model: config.model,
    api_key_env: config.api_key_env,
    max_tokens: config.max_tokens,
    temperature: config.temperature,
    requiresNoAuth: providerRequiresNoAuth(config.provider),
  };
}

type ScalarField = "provider" | "base_url" | "endpoint" | "model" | "api_key_env" | "max_tokens" | "temperature";

/** Sets (replacing an existing line) or appends (if absent) one top-level `key: value` line in
 *  `lines`, only ever matching/inserting at column 0 so nested keys under `overrides:` or
 *  `fallback:` are never touched. Appends just before the first indented or blank-adjacent
 *  boundary if the key doesn't exist yet, so a freshly-added `api_key_env` (e.g. switching from
 *  ollama, which may omit it, to a provider that needs one) lands in a sensible place rather
 *  than at the very end of the file, after `overrides`/`fallback`. */
function setTopLevelKey(lines: string[], key: ScalarField, value: string): string[] {
  const pattern = new RegExp(`^${key}:\\s`);
  const idx = lines.findIndex((l) => pattern.test(l));
  if (idx !== -1) {
    // Preserve any trailing inline comment on the existing line (e.g. "temperature: 0.0            # deterministic...").
    const commentMatch = lines[idx].match(/\s{2,}#.*$/);
    const next = [...lines];
    next[idx] = `${key}: ${value}${commentMatch ? commentMatch[0] : ""}`;
    return next;
  }
  // Not present — insert right after the last top-level scalar key found so far (provider/
  // base_url/endpoint/model/api_key_env/max_tokens/temperature/thinking), before overrides/fallback.
  const lastScalarIdx = (() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^(provider|base_url|endpoint|model|api_key_env|max_tokens|temperature|thinking):/.test(lines[i])) return i;
    }
    return -1;
  })();
  const insertAt = lastScalarIdx !== -1 ? lastScalarIdx + 1 : lines.length;
  const next = [...lines];
  next.splice(insertAt, 0, `${key}: ${value}`);
  return next;
}

/** Removes a top-level `key:` line entirely (used when switching to a provider that doesn't use
 *  a given field — e.g. clearing api_key_env when switching to ollama with no reverse proxy). */
function removeTopLevelKey(lines: string[], key: ScalarField): string[] {
  const pattern = new RegExp(`^${key}:\\s`);
  return lines.filter((l) => !pattern.test(l));
}

export interface LlmConfigUpdate {
  provider?: string;
  base_url?: string;
  endpoint?: string;
  model?: string;
  api_key_env?: string;
  max_tokens?: number;
  temperature?: number;
}

/** Applies a partial update to llm.yaml's top-level scalar keys and returns the resulting
 *  summary. Throws if the config file doesn't exist yet (nothing to surgically edit — same
 *  "no config file" case loadLlmConfig() already handles by falling back to hardcoded defaults
 *  in memory; writing a *new* file from scratch is out of scope here since there'd be no
 *  comments to preserve in the first place, and this path shouldn't be reachable in a normal
 *  install where agent/config/llm.yaml ships with the repo). */
export function updateLlmConfig(update: LlmConfigUpdate): LlmConfigSummary {
  const yamlPath = llmConfigYamlPath();
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`No llm.yaml found at ${yamlPath} — nothing to update. Create the file first (see agent/config/llm.yaml in the repo for the expected format).`);
  }

  let lines = fs.readFileSync(yamlPath, "utf-8").split("\n");

  if (update.provider !== undefined) lines = setTopLevelKey(lines, "provider", update.provider);
  if (update.base_url !== undefined) {
    lines = update.base_url === "" ? removeTopLevelKey(lines, "base_url") : setTopLevelKey(lines, "base_url", update.base_url);
  }
  if (update.endpoint !== undefined) {
    lines = update.endpoint === "" ? removeTopLevelKey(lines, "endpoint") : setTopLevelKey(lines, "endpoint", update.endpoint);
  }
  if (update.model !== undefined) lines = setTopLevelKey(lines, "model", update.model);
  if (update.api_key_env !== undefined) {
    lines = update.api_key_env === "" ? removeTopLevelKey(lines, "api_key_env") : setTopLevelKey(lines, "api_key_env", update.api_key_env);
  }
  if (update.max_tokens !== undefined) lines = setTopLevelKey(lines, "max_tokens", String(update.max_tokens));
  if (update.temperature !== undefined) lines = setTopLevelKey(lines, "temperature", String(update.temperature));

  fs.writeFileSync(yamlPath, lines.join("\n"), "utf-8");
  return getLlmConfigSummary();
}

/** Re-exported so routes.ts / the frontend can offer a "known providers" dropdown without
 *  duplicating this list. */
export function knownProviders(): string[] {
  return Object.keys(KNOWN_PROVIDER_DEFAULTS);
}

export type { LlmConfig };
