import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import {
  PULLED_MODELS,
  DEFAULT_OLLAMA_MODEL,
  ollamaApiRoot,
  isAllowedModel,
  listModels,
} from "../ollamaModels.js";

/**
 * Two kinds of test live here.
 *
 * The consistency group asserts that three files which have to agree actually do:
 * agent/config/llm.yaml (what the backend runs by default), docker-compose.yml's
 * ollama-pull-model service (what actually gets downloaded), and PULLED_MODELS in
 * ollamaModels.ts (what the UI offers when Ollama can't be reached). These drift silently —
 * nothing fails at build time if the default model is changed in one place and not the others,
 * you just get a model picker offering something that was never pulled, or a backend defaulting
 * to a model the sidecar doesn't fetch. So they're checked against each other by parsing the
 * real files rather than by restating the values.
 *
 * The behavioural group covers listModels()'s fallback path, which is the one that matters
 * operationally: Ollama being slow or down during page load must degrade to a usable picker,
 * never an empty one.
 */

const LLM_YAML = "agent/config/llm.yaml";
const COMPOSE = "docker-compose.yml";

describe("model list consistency across config, compose, and code", () => {
  it("the shipped llm.yaml default matches DEFAULT_OLLAMA_MODEL", () => {
    const doc = yaml.load(readFileSync(LLM_YAML, "utf-8")) as { model?: string };
    expect(doc.model).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it("the compose pull sidecar fetches the default model as a required (non-optional) pull", () => {
    const compose = yaml.load(readFileSync(COMPOSE, "utf-8")) as any;
    const command = compose.services["ollama-pull-model"].command[0] as string;

    // The default must be pulled WITHOUT a `|| echo` fallback — if it fails, the container has
    // to exit non-zero so `api`'s service_completed_successfully dependency holds it back.
    const defaultPullLine = command
      .split("\n")
      .find((l) => l.includes(DEFAULT_OLLAMA_MODEL) && l.includes("api/pull"));
    expect(defaultPullLine, `no pull line for ${DEFAULT_OLLAMA_MODEL}`).toBeTruthy();
    expect(defaultPullLine).not.toContain("||");
  });

  it("every model in PULLED_MODELS is actually pulled by the compose sidecar", () => {
    const compose = yaml.load(readFileSync(COMPOSE, "utf-8")) as any;
    const command = compose.services["ollama-pull-model"].command[0] as string;
    const missing = PULLED_MODELS.filter((m) => !command.includes(m));
    expect(missing, "PULLED_MODELS entries with no corresponding pull in docker-compose.yml").toEqual([]);
  });

  it("api waits for the pull sidecar to finish before starting", () => {
    // Without this, a cold start can bring the backend up against an Ollama that hasn't got
    // the default model yet, and the first chat fails with a model-not-found error.
    const compose = yaml.load(readFileSync(COMPOSE, "utf-8")) as any;
    expect(compose.services.api.depends_on["ollama-pull-model"]).toEqual({
      condition: "service_completed_successfully",
    });
  });

  it("declares the ollama_storage volume the ollama service mounts", () => {
    const compose = yaml.load(readFileSync(COMPOSE, "utf-8")) as any;
    expect(Object.keys(compose.volumes)).toContain("ollama_storage");
    expect(compose.services.ollama.volumes).toContain("ollama_storage:/root/.ollama");
  });

  it("does not tie ollama's healthcheck to model presence", () => {
    // `api` gates on ollama being healthy. If healthy also meant "models pulled", a failed
    // pull would deadlock the whole stack instead of just failing the sidecar.
    const compose = yaml.load(readFileSync(COMPOSE, "utf-8")) as any;
    const test = JSON.stringify(compose.services.ollama.healthcheck.test);
    for (const model of PULLED_MODELS) {
      expect(test).not.toContain(model);
    }
  });
});

describe("ollamaApiRoot", () => {
  it("strips the OpenAI-compat /v1 suffix to reach Ollama's native API", () => {
    // /api/tags lives at the root, not under /v1 — getting this wrong silently 404s and
    // sends the picker down the fallback path forever.
    expect(ollamaApiRoot("http://ollama:11434/v1")).toBe("http://ollama:11434");
  });

  it("tolerates a trailing slash", () => {
    expect(ollamaApiRoot("http://ollama:11434/v1/")).toBe("http://ollama:11434");
  });

  it("leaves a base url that has no /v1 suffix alone", () => {
    expect(ollamaApiRoot("http://ollama:11434")).toBe("http://ollama:11434");
  });
});

describe("isAllowedModel", () => {
  it("accepts a model the server enumerated", () => {
    expect(isAllowedModel("granite4:1b", ["granite4:1b", "hermes3:3b"])).toBe(true);
  });

  it("rejects anything not enumerated", () => {
    // The point of the allowlist: this string goes straight into the outbound LLM request.
    expect(isAllowedModel("gpt-4o", ["granite4:1b"])).toBe(false);
  });

  it("does not match on prefix or substring", () => {
    expect(isAllowedModel("granite4", ["granite4:1b"])).toBe(false);
    expect(isAllowedModel("granite4:1b-evil", ["granite4:1b"])).toBe(false);
  });
});

describe("listModels", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("returns live model names when Ollama answers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "granite4:1b" }, { name: "hermes3:3b" }] }),
    }) as unknown as typeof fetch;

    const result = await listModels();
    expect(result.source).toBe("live");
    expect(result.models).toContain("hermes3:3b");
  });

  it("falls back to the compose-pulled list when Ollama is unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const result = await listModels();
    expect(result.source).toBe("fallback");
    // The operationally important property: never an empty picker.
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models).toContain(DEFAULT_OLLAMA_MODEL);
  });

  it("falls back when Ollama answers but has nothing pulled yet", async () => {
    // Real cold-start state: the server is up and healthy while the sidecar is still working.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    }) as unknown as typeof fetch;

    const result = await listModels();
    expect(result.source).toBe("fallback");
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("falls back on a non-2xx response rather than throwing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;

    const result = await listModels();
    expect(result.source).toBe("fallback");
  });

  it("always lists the configured default first and exactly once", async () => {
    // Ollama reporting the default among its tags must not produce a duplicate entry, and a
    // default that hasn't been pulled must still be selectable.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "hermes3:3b" }, { name: DEFAULT_OLLAMA_MODEL }] }),
    }) as unknown as typeof fetch;

    const result = await listModels();
    expect(result.models[0]).toBe(result.default);
    expect(result.models.filter((m) => m === result.default)).toHaveLength(1);
  });

  it("gives up on a hung Ollama instead of stalling the caller", async () => {
    // listModels() populates a dropdown on page load; an unbounded wait would hang the tab.
    globalThis.fetch = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    ) as unknown as typeof fetch;

    const started = Date.now();
    const result = await listModels(100);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.source).toBe("fallback");
  });
});
