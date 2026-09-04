/**
 * Server-side store for the SecurityOps red-team TARGET_ALLOWLIST — the authoritative gate on
 * every red-team tool that touches a network target (port_scanner, subdomain_enum,
 * http_header_audit, tls_config_check; also enforced on blue team's cert_expiry_check, which
 * also dials out). Any target whose hostname doesn't match an allowlist entry exactly, or as a
 * subdomain of one, is refused before the tool runs — there is no "scan anything" mode.
 *
 * This is deliberately a strict allowlist, not a denylist: xcoder is a general-purpose
 * orchestration platform that could otherwise be pointed at arbitrary hosts by task text (or a
 * prompt-injected instruction from a crawled page), so scanning defaults to "nothing" until an
 * admin explicitly adds targets, rather than "everything except a blocked list."
 */

const DEFAULT_ALLOWLIST = ["localhost", "127.0.0.1", "::1"];

function envDefault(): string[] {
  const raw = process.env.XCODER_SECOPS_ALLOWLIST;
  if (!raw) return [...DEFAULT_ALLOWLIST];
  const fromEnv = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // localhost/127.0.0.1 are always implicitly allowed regardless of env config — scanning your
  // own machine is never the risky case this gate exists for.
  return Array.from(new Set([...DEFAULT_ALLOWLIST, ...fromEnv]));
}

let allowlist: string[] = envDefault();

export function getAllowlist(): string[] {
  return [...allowlist];
}

export function setAllowlist(entries: string[]): string[] {
  const cleaned = Array.from(
    new Set([...DEFAULT_ALLOWLIST, ...entries.map((e) => e.trim().toLowerCase()).filter(Boolean)])
  );
  allowlist = cleaned;
  return getAllowlist();
}

function hostnameOf(v: string): string {
  try {
    return new URL(v).hostname;
  } catch {
    return String(v || "")
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .split(":")[0];
  }
}

export function isAllowedTarget(raw: string): boolean {
  const host = hostnameOf(raw).toLowerCase();
  return allowlist.some((a) => host === a || host.endsWith("." + a));
}

export class TargetNotAllowedError extends Error {
  host: string;
  constructor(host: string) {
    super(`Target '${host}' is not in TARGET_ALLOWLIST.`);
    this.host = host;
  }
}

export function requireAllowedTarget(raw: string): void {
  if (!isAllowedTarget(raw)) throw new TargetNotAllowedError(hostnameOf(raw));
}

export { hostnameOf };
