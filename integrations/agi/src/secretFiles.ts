import fs from "node:fs";

/**
 * Docker-secrets style `<VAR>_FILE` support for the two shared secrets, resolved at import time so it must be
 * the FIRST import of an entrypoint (config.ts reads the environment when it loads). An explicit allowlist, not
 * a blanket `*_FILE` match. An explicitly set VAR always wins over its file.
 */
export const SECRET_VARS = ["AGI_API_TOKEN", "SANDBOX_TOKEN"] as const;

export function resolveSecretFiles(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of SECRET_VARS) {
    const file = env[`${name}_FILE`];
    if (!file || env[name]) continue;
    try { env[name] = fs.readFileSync(file, "utf8").trim(); }
    catch (e) { console.error(`[secrets] ${name}_FILE=${file} unreadable: ${(e as Error).message}`); }
  }
}
resolveSecretFiles();
