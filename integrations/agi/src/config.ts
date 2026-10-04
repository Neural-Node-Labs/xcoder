import path from "node:path";

/** Env var with default; empty strings (as docker compose passes for unset vars) count as unset. */
const env = (k: string, d: string) => (process.env[k] ? (process.env[k] as string) : d);

export const DATA_DIR = env("DATA_DIR", "/data");
export const AGENT_DIR = path.join(DATA_DIR, "agent");      // writable by the agent
export const CONTROL_DIR = path.join(DATA_DIR, "control");  // root-owned, written only by the supervisor
export const SANDBOX_URL = env("SANDBOX_URL", "http://sandbox:9000");
export const SANDBOX_TOKEN = env("SANDBOX_TOKEN", "");
export const PORT = Number(env("PORT", "7000"));
export const LLM_MODE = env("LLM_MODE", "mock") as "mock" | "anthropic";
export const EVOLVE_APPROVAL = env("EVOLVE_APPROVAL", "prompts") as "never" | "prompts" | "always";
export const EVOLVE_EPSILON = Number(env("EVOLVE_EPSILON", LLM_MODE === "mock" ? "0" : "0.02"));
export const GOAL_LOOP_MINUTES = Number(env("GOAL_LOOP_MINUTES", "0"));
export const MODELS = {
  easy: env("MODEL_EASY", "claude-haiku-4-5-20251001"),
  medium: env("MODEL_MEDIUM", "claude-sonnet-5-5"),
  hard: env("MODEL_HARD", "claude-opus-5-5"),
};
