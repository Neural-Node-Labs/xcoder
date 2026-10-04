import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSecretFiles } from "../src/secretFiles";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const w = (n: string, v: string) => { const f = path.join(dir, n); fs.writeFileSync(f, v); return f; };

describe("resolveSecretFiles", () => {
  it("loads the allowlisted secrets from *_FILE and trims whitespace", () => {
    const env: NodeJS.ProcessEnv = { AGI_API_TOKEN_FILE: w("a", "abc123abc123abc123\n"), SANDBOX_TOKEN_FILE: w("s", "  sbx-secret-value-1  ") };
    resolveSecretFiles(env);
    expect(env.AGI_API_TOKEN).toBe("abc123abc123abc123");
    expect(env.SANDBOX_TOKEN).toBe("sbx-secret-value-1");
  });
  it("an explicitly set variable wins over its file", () => {
    const env: NodeJS.ProcessEnv = { AGI_API_TOKEN: "from-env-from-env-1", AGI_API_TOKEN_FILE: w("a", "from-file") };
    resolveSecretFiles(env);
    expect(env.AGI_API_TOKEN).toBe("from-env-from-env-1");
  });
  it("a missing file is reported but never throws, and leaves the variable unset", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const env: NodeJS.ProcessEnv = { AGI_API_TOKEN_FILE: path.join(dir, "nope") };
    expect(() => resolveSecretFiles(env)).not.toThrow();
    expect(env.AGI_API_TOKEN).toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
  it("ignores *_FILE for anything outside the allowlist", () => {
    const env: NodeJS.ProcessEnv = { SSL_CERT_FILE: w("c", "x"), OTHER_FILE: w("o", "y") };
    resolveSecretFiles(env);
    expect(Object.keys(env).sort()).toEqual(["OTHER_FILE", "SSL_CERT_FILE"]);
  });
});
