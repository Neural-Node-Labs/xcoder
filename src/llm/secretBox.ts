import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { saasDataDir } from "../saas/storage.js";

/**
 * Authenticated encryption (AES-256-GCM) for stored secrets: tenant LLM keys, dedicated-AGI tokens.
 * Master key: XCODER_SECRET_KEY (any string, 16+ chars; derived with scrypt) or, if unset, a random key generated once
 * into <saasDataDir>/secret.key (0600). Production should set XCODER_SECRET_KEY from a secrets manager so the key does
 * not live next to the ciphertext. Losing the key makes stored secrets unreadable (they must be re-entered).
 */
let cached: Buffer | null = null;
export function resetSecretKeyForTests() { cached = null; }

function masterKey(): Buffer {
  if (cached) return cached;
  const env = process.env.XCODER_SECRET_KEY?.trim();
  if (env) {
    if (env.length < 16) throw new Error("XCODER_SECRET_KEY must be at least 16 characters");
    cached = crypto.scryptSync(env, "xcoder-secretbox-v1", 32);
    return cached;
  }
  const f = path.join(saasDataDir(), "secret.key");
  try { cached = Buffer.from(fs.readFileSync(f, "utf8").trim(), "hex"); if (cached.length === 32) return cached; } catch { /* generate */ }
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  cached = crypto.randomBytes(32);
  fs.writeFileSync(f, cached.toString("hex"), { mode: 0o600 });
  return cached;
}

export interface Sealed { v: 1; iv: string; tag: string; ct: string }
export function seal(plain: string): Sealed {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}
/** Returns undefined (never throws) when the blob is malformed, tampered with, or the master key changed. */
export function open(s: Sealed | undefined): string | undefined {
  if (!s || s.v !== 1) return undefined;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(s.iv, "base64"));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]).toString("utf8");
  } catch { return undefined; }
}
