import dns from "node:dns/promises";
import net from "node:net";

/** True for loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, ULA, multicast, unspecified and IPv4-mapped forms of those. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === "::" || l === "::1" || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb") || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("ff");
  }
  return true; // not an IP we understand: refuse
}

export interface UrlPolicy { allowPrivate?: boolean; allowHttp?: boolean; lookup?: (host: string) => Promise<string[]> }

/**
 * Validates a tenant-supplied model-provider URL before the server ever calls it (SSRF guard).
 * Requires https, no credentials in the URL, and every address the host resolves to must be public.
 * Returns the normalised origin+path, or throws Error with a user-safe message.
 * Residual risk: DNS can change between this check and the request (rebinding); the resolver re-checks on every client
 * construction, and egress filtering at the network layer is the complete fix.
 */
export async function assertSafeProviderUrl(raw: string, policy: UrlPolicy = {}): Promise<string> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("base_url is not a valid URL"); }
  if (u.username || u.password) throw new Error("base_url must not contain credentials");
  if (u.protocol !== "https:" && !(policy.allowHttp && u.protocol === "http:")) throw new Error("base_url must use https");
  if (policy.allowPrivate) return u.toString().replace(/\/$/, "");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  if (net.isIP(host)) addrs = [host];
  else {
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) throw new Error("base_url host is not a public address");
    try { addrs = policy.lookup ? await policy.lookup(host) : (await dns.lookup(host, { all: true })).map((a) => a.address); } catch { throw new Error("base_url host could not be resolved"); }
  }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new Error("base_url host is not a public address");
  return u.toString().replace(/\/$/, "");
}
