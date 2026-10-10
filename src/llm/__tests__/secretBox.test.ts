import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, seal, resetSecretKeyForTests } from "../secretBox.js";

describe("secretBox", () => {
  beforeEach(() => { process.env.XCODER_SAAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sb-")); delete process.env.XCODER_SECRET_KEY; resetSecretKeyForTests(); });
  it("round-trips, uses a fresh IV, and never stores plaintext", () => {
    const a = seal("sk-secret-123"), b = seal("sk-secret-123");
    expect(open(a)).toBe("sk-secret-123"); expect(a.iv).not.toBe(b.iv); expect(JSON.stringify(a)).not.toContain("secret");
  });
  it("detects tampering and a changed master key", () => {
    const a = seal("sk-secret-123");
    expect(open({ ...a, ct: Buffer.from("x" + Buffer.from(a.ct, "base64").toString("latin1").slice(1), "latin1").toString("base64") })).toBeUndefined();
    process.env.XCODER_SECRET_KEY = "a-different-master-key-1234"; resetSecretKeyForTests();
    expect(open(a)).toBeUndefined();
  });
  it("persists the generated key with owner-only permissions", () => {
    seal("x"); const f = path.join(process.env.XCODER_SAAS_DATA_DIR!, "secret.key");
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
  it("rejects a weak XCODER_SECRET_KEY", () => { process.env.XCODER_SECRET_KEY = "short"; resetSecretKeyForTests(); expect(() => seal("x")).toThrow(/16/); });
});
