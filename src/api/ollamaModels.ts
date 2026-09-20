import { loadLlmConfig, providerRequiresNoAuth } from "../config/loadConfig.js";

/**
 * Model discovery for the Chat tab's model picker.
 *
 * The picker needs a list of models the user can actually switch to. The authoritative answer
 * lives in Ollama itself (`GET /api/tags` lists what's been pulled), but that call can fail for
 * perfectly ordinary reasons — Ollama still starting, the pull sidecar not finished, xcoder
 * running against a cloud provider instead. A failed lookup must never leave the picker empty,
 * so this falls back to the set docker-compose pulls on first boot. Worst case the user sees a
 * model that isn't pulled yet and Ollama pulls it on demand; that's a far better failure than
 * a dropdown with nothing in it.
 */

/** The models docker-compose's `ollama-pull-model` sidecar pulls on first start. Kept in sync
 *  with that service by ollamaModels.test.ts, which parses the compose file rather than
 *  trusting this list to be updated by hand. */
export const PULLED_MODELS = [
  "granite4:1b",
  "qwen2.5:1.5b",
  "ministral-3:3b",
  "hermes3:3b",
  "smollm2:1.7b",
] as const;

/** xcoder's shipped default. Must match `model:` in agent/config/llm.yaml — asserted by test. */
export const DEFAULT_OLLAMA_MODEL = "granite4:1b";

export interface ModelListResult {
  models: string[];
  /** The model a request gets if it doesn't ask for one — i.e. whatever llm.yaml configures. */
  default: string;
  /** "live" = read from Ollama's own /api/tags. "fallback" = Ollama unreachable, this is the
   *  compose-pulled list. "config" = provider isn't Ollama, so there's nothing to enumerate. */
  source: "live" | "fallback" | "config";
}

/**
 * Turns an OpenAI-compatible base_url into the Ollama *native* API root.
 * Ollama serves its OpenAI-shaped endpoints under /v1 but its own (including /api/tags) at the
 * root, so "http://ollama:11434/v1" has to become "http://ollama:11434".
 */
export function ollamaApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

interface OllamaTagsResponse {
  models?: { name?: string }[];
}

/**
 * Lists the models available for this install. Never throws and never returns an empty list —
 * see the module comment for why that matters more than strict accuracy here.
 *
 * @param timeoutMs how long to wait on Ollama before falling back. Deliberately short: this is
 *   called to populate a dropdown on page load, so a hung request would stall the Chat tab.
 */
export async function listModels(timeoutMs = 2500): Promise<ModelListResult> {
  const config = loadLlmConfig();
  const configuredDefault = config.model || DEFAULT_OLLAMA_MODEL;

  // Only Ollama exposes a "what's installed here" endpoint worth enumerating. For a cloud
  // provider the set of valid models is the provider's whole catalog, which isn't something
  // to guess at — report just the configured model and let Settings handle changing it.
  if (config.provider !== "ollama") {
    return { models: [configuredDefault], default: configuredDefault, source: "config" };
  }

  const baseUrl = config.base_url;
  if (!baseUrl) {
    return { models: withDefault(PULLED_MODELS, configuredDefault), default: configuredDefault, source: "fallback" };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      const headers: Record<string, string> = {};
      // A reverse-proxied Ollama can require auth even though a local one doesn't — mirror
      // whatever the LLM client itself would send rather than assuming an open server.
      if (!providerRequiresNoAuth(config.provider) && config.api_key_env) {
        const key = process.env[config.api_key_env];
        if (key) headers["Authorization"] = `Bearer ${key}`;
      }
      res = await fetch(`${ollamaApiRoot(baseUrl)}/api/tags`, { signal: controller.signal, headers });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      return { models: withDefault(PULLED_MODELS, configuredDefault), default: configuredDefault, source: "fallback" };
    }

    const body = (await res.json()) as OllamaTagsResponse;
    const names = (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);

    if (names.length === 0) {
      // Ollama answered but has nothing pulled yet (the sidecar is still working). The
      // compose list is a better answer than an empty picker.
      return { models: withDefault(PULLED_MODELS, configuredDefault), default: configuredDefault, source: "fallback" };
    }

    return { models: withDefault(names, configuredDefault), default: configuredDefault, source: "live" };
  } catch {
    // Unreachable, DNS failure, timeout, malformed JSON — all the same answer.
    return { models: withDefault(PULLED_MODELS, configuredDefault), default: configuredDefault, source: "fallback" };
  }
}

/** Guarantees the configured default is selectable, deduped and listed first. Without this, a
 *  default that hasn't been pulled yet would be missing from the very dropdown that's supposed
 *  to show which model is in use. */
function withDefault(models: readonly string[], configuredDefault: string): string[] {
  return [configuredDefault, ...models.filter((m) => m !== configuredDefault)];
}

/**
 * Decides whether a caller-supplied model name may be used for this request.
 *
 * This is an allowlist check, not a sanity check. The model string is written straight into the
 * outbound LLM request, so accepting arbitrary input would let any authenticated user point
 * xcoder's backend at a model of their choosing — including, on a reverse-proxied or cloud
 * endpoint, a far more expensive one than the operator configured. Only names the server itself
 * just enumerated are accepted.
 */
export function isAllowedModel(requested: string, allowed: readonly string[]): boolean {
  return allowed.includes(requested);
}
