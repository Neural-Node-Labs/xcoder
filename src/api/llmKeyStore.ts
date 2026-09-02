import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { LlmConfig } from "../config/loadConfig.js";

const STORE_PATH = path.join(os.homedir(), ".devnull", "llm-key.json");

export function getStoredApiKey(): string | undefined {
  if (!fs.existsSync(STORE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    return typeof parsed.apiKey === "string" ? parsed.apiKey : undefined;
  } catch {
    return undefined;
  }
}

export function hasStoredApiKey(): boolean {
  return Boolean(getStoredApiKey());
}

/** file mode 0600: readable/writable by the owner only — this is a plaintext local file, not a
 *  proper secrets store, so restricting OS-level file permissions is the minimum reasonable bar. */
export function setStoredApiKey(apiKey: string): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify({ apiKey }), { encoding: "utf-8", mode: 0o600 });
}

export function clearStoredApiKey(): void {
  if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
}

/** Makes any stored key visible to the existing process.env[config.api_key_env] lookup that
 *  deepseekClient.ts already does — no changes needed there. Call before constructing a client.
 *  No-op when the config has no `api_key_env` (e.g. a local, unauthenticated provider like
 *  ollama) since there is no environment variable to populate. */
export function applyStoredApiKey(config: LlmConfig): void {
  if (!config.api_key_env) return;
  const stored = getStoredApiKey();
  if (stored) process.env[config.api_key_env] = stored;
}

