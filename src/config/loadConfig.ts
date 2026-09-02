// ronin:version 2 | ronin:task task-d8bbc5 | ronin:updated 2026-08-13T07:19:27.550Z | ronin:subtask code-st-db60d1
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import "dotenv/config";
import { resolveFirstExistingPath } from "./paths.js";

/**
 * Konpigurasyon ng LLM backend — ang tanging pinagmumulan ng katotohanan kung aling
 * provider ang kinakausap ng devnull.
 *
 * - Tinutukoy ng `provider` ang aktibong backend: `"anthropic"` o kahit anong provider
 *   na OpenAI-compatible (`"deepseek"`, `"openai"`, `"openrouter"`, `"groq"`, `"ollama"`,
 *   o isang custom na pangalan).
 * - REQUIRED ang `base_url`/`endpoint` para sa mga OpenAI-compatible provider (hindi ito
 *   ginagamit ng Anthropic, dahil fixed ang kanyang Messages endpoint). Kapag naroroon ang
 *   `base_url` pero wala ang `endpoint`, ang default ng `endpoint` ay `/chat/completions`.
 *   Kapag wala ang `base_url` at kilalang provider ang `provider`, kukunin ito mula sa
 *   `DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS`.
 * - Tinutukoy ng `api_key_env` ang environment variable na naghahawak ng key — HINDI kailanman
 *   inilalagay ang mga key diretso sa yaml. OPSYONAL ito para sa mga provider na nasa
 *   `NO_AUTH_PROVIDERS` (kasalukuyan: `ollama`) — ang mga lokal, unauthenticated na server ay
 *   hindi nangangailangan ng key, kaya walang Authorization header na ipinapadala kapag walang
 *   ibinigay na `api_key_env` (o kapag walang laman ang environment variable na tinutukoy
 *   nito). Para sa lahat ng iba pang provider, REQUIRED pa rin ang `api_key_env`.
 */
export interface LlmConfig {
  provider: string;
  base_url?: string; // required para sa openai-compatible providers (deepseek, atbp); hindi ginagamit ng anthropic
  endpoint?: string; // required para sa openai-compatible providers (deepseek, atbp); hindi ginagamit ng anthropic
  model: string;
  api_key_env?: string; // opsyonal para sa mga provider sa NO_AUTH_PROVIDERS (hal. ollama); required sa iba
  max_tokens: number;
  temperature: number;
  thinking?: boolean;
  reasoning_effort?: "high" | "max"; // may kahulugan lamang kapag naka-enable ang thinking
  overrides?: Record<string, { model?: string; temperature?: number; thinking?: boolean; reasoning_effort?: "high" | "max" }>;
  fallback?: { provider: string; model: string; api_key_env?: string; base_url?: string; endpoint?: string };
}

const RELATIVE_CONFIG_PATH = path.join("agent", "config", "llm.yaml");
const RELATIVE_HOME_PATH = path.join("agent");
const RELATIVE_AGENT_PATH = path.join(".agent");

/** Mga kilalang base URL para sa karaniwang OpenAI-compatible providers, para makapag-switch
 *  ang llm.yaml sa pamamagitan lamang ng pagbanggit ng provider. Ang tahasang `config.base_url`
 *  ay LAGING mananaig kaysa sa mapang ito. */
export const DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434/v1",
};

/** Backward-compatible alias para sa dati nang (private) pangalan ng constant. */
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URLS = DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS;

/**
 * Mga provider na tumatakbo nang lokal at hindi nangangailangan ng authentication -- ang mga
 * ito ay maaaring may isang tahasang `api_key_env`/`fallback.api_key_env` na tinukoy sa
 * kanilang config (kung gagamitin ang lokal na server na may reverse proxy na may sariling
 * auth) pero hindi ito ipinipilit. Kasalukuyan lamang: `ollama`, na sa default ay tumatakbo sa
 * `http://localhost:11434` nang walang anumang authentication layer. */
export const NO_AUTH_PROVIDERS = new Set(["ollama"]);

/** True kung hindi kailangan ng provider na ito ng API key para makapagpadala ng request. */
export function providerRequiresNoAuth(provider: string): boolean {
  return NO_AUTH_PROVIDERS.has(provider);
}

/** Alamin ang OpenAI-compatible base URL para sa isang config: mananaig ang tahasang base_url,
 *  kung wala, kokonsultahin ang registry ng kilalang provider. Nagbabalik ng undefined para sa
 *  mga hindi kilalang provider na walang tahasang base_url (kailangang ipakita ng caller ang
 *  error ng maling konpigurasyon). */
export function resolveOpenAiBaseUrl(config: Pick<LlmConfig, "provider" | "base_url">): string | undefined {
  return config.base_url ?? DEFAULT_OPENAI_COMPATIBLE_PROVIDER_URLS[config.provider];
}

/** Ang default ng OpenAI-compatible endpoint ay /chat/completions kapag naroroon ang base_url. */
export function resolveOpenAiEndpoint(config: Pick<LlmConfig, "endpoint">): string {
  return config.endpoint ?? "/chat/completions";
}


/**
 * Rine-resolba ang direktoryo ng "agent/" na naglalaman ng config/llm.yaml, sa pamamagitan ng
 * pagsuri sa mga candidate na ito nang may priyoridad: DEVNULL_HOME env var > current working
 * directory > home directory ng user > app/source directory. Kinokonsumo ang shared na
 * candidate-search resolver sa src/config/paths.ts sa halip na magpanatili ng sarili nitong
 * kopya ng logic na ito (dating dalawang beses na na-duplicate dito, na naiba pa sa priyoridad
 * at may bug sa fallback constant).
 */
export function resolveConfigPath(): string {
  return resolveFirstExistingPath(RELATIVE_HOME_PATH, { logResolution: true });
}

/** Rine-resolba ang .agent/ na direktoryo ng workspace gamit ang parehong shared na resolver. */
export function resolveAgentPath(): string {
  return resolveFirstExistingPath(RELATIVE_AGENT_PATH, { logResolution: true });
}

export function loadLlmConfig(configPath: string = path.join(resolveConfigPath(), "config", "llm.yaml")): LlmConfig {
  if (!fs.existsSync(configPath)) {
    // Makatwirang default: DeepSeek sa non-thinking mode, kasalukuyang model IDs, temperature 0.0
    // batay sa opisyal na gabay ng DeepSeek para sa code/math na gawain (coding agent ito).
    return {
      provider: "deepseek",
      base_url: "https://api.deepseek.com/v1",
      endpoint: "/chat/completions",
      model: "deepseek-v4-flash",
      api_key_env: "DEEPSEEK_API_KEY",
      max_tokens: 16384,
      temperature: 0.0,
      thinking: false,
    };
  }
  //console.log(`Configuration Path: ${configPath}`) — naka-comment out, para lang sa debugging
  const raw = fs.readFileSync(configPath, "utf-8");
  return yaml.load(raw) as LlmConfig;
}

export function resolveModelForSkill(config: LlmConfig, skillName?: string) {
  const override = skillName ? config.overrides?.[skillName] : undefined;
  return {
    model: override?.model ?? config.model,
    temperature: override?.temperature ?? config.temperature,
    thinking: override?.thinking ?? config.thinking ?? false,
    reasoningEffort: override?.reasoning_effort ?? config.reasoning_effort,
  };
}

export function validateFallbackConfig(config: LlmConfig): string[] {
  const errors: string[] = [];

  // Kung opsyonal ang fallback at hindi ito nakadefine, agad ibalik nang walang errors
  if (!config.fallback) {
    return errors;
  }

  const { provider, model, api_key_env, base_url } = config.fallback;

  // I-validate ang mga required na field
  if (!provider) {
    errors.push("Missing or empty fallback.provider");
  }

  if (!model) {
    errors.push("Missing or empty fallback.model");
  }

  if (!api_key_env) {
    // Opsyonal ang api_key_env para sa mga lokal, unauthenticated na provider (ollama).
    // Para sa lahat ng iba pa, required pa rin ito.
    if (!providerRequiresNoAuth(provider)) {
      errors.push("Missing or empty fallback.api_key_env");
    }
  } else {
    // Suriin kung umiiral at hindi walang laman ang tinutukoy na environment variable
    if (!process.env[api_key_env]) {
      errors.push(`Environment variable specified in fallback.api_key_env (${api_key_env}) is unset or empty`);
    }
  }

  // Suriin ang mga requirement sa base_url para sa OpenAI-compatible providers na hindi anthropic
  if (provider && provider !== "anthropic") {
    const resolvedUrl = resolveOpenAiBaseUrl({ provider, base_url });
    if (!resolvedUrl) {
      errors.push(`fallback.base_url is required for provider '${provider}'`);
    }
  }

  return errors;
}


