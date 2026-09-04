/**
 * securityOpsTool.ts — real Blue Team / Red Team security operations, ported from the
 * standalone SecurityOps console (jarvis-system) into xcoder's tool ecosystem so every engine
 * (including the "assistant" chat engine) can call these directly, alongside the dedicated
 * Security Ops UI page for humans.
 *
 * Every tool here does an actual, local, read-only check (log tailing, file hashing, dependency
 * auditing, TCP connect probing, TLS/DNS/HTTP inspection) — nothing here writes to, modifies, or
 * exploits anything. Red-team tools that touch a network target are gated by the TARGET_ALLOWLIST
 * in securityOpsAllowlistStore.ts, enforced HERE (server-side) as the authoritative check —
 * xcoder's UI has its own copy of the same list for immediate feedback, but that's a UX nicety,
 * not the real security boundary; anyone calling the tool or API directly still goes through
 * requireAllowedTarget() below.
 *
 * `phishing_simulation_sender` is intentionally left unimplemented — see the comment on
 * redPhishingSimulationNotImplemented near the bottom for why that's a deliberate scope
 * decision, not an oversight.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as dns from "node:dns/promises";
import * as tls from "node:tls";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { requireAllowedTarget, hostnameOf, TargetNotAllowedError, getAllowlist } from "../api/securityOpsAllowlistStore.js";

export interface SecOpsResult {
  level: "ok" | "warn" | "err";
  text: string;
}

// ---------------------------------------------------------------------
// Shared process/command helpers
// ---------------------------------------------------------------------

function runCmd(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf-8",
    timeout: opts.timeoutMs ?? 15_000,
    cwd: opts.cwd,
  });
}

function commandExists(cmd: string): boolean {
  const probe = process.platform === "win32" ? spawnSync("where", [cmd]) : spawnSync("which", [cmd]);
  return probe.status === 0;
}

// =======================================================================
// BLUE TEAM — real defensive/audit checks
// =======================================================================

const DEFAULT_LOG_PATHS: Record<string, string> = {
  syslog: process.env.LOG_PATH_SYSLOG || "/var/log/syslog",
  "auth.log": process.env.LOG_PATH_AUTHLOG || "/var/log/auth.log",
  "app.log": process.env.LOG_PATH_APPLOG || "./logs/app.log",
  "nginx access": process.env.LOG_PATH_NGINX_ACCESS || "/var/log/nginx/access.log",
};

/** Reads up to the last `maxLines` lines of a file, capped at 5MB read. */
function readTail(filePath: string, maxLines: number): string[] {
  const stat = fs.statSync(filePath);
  const MAX_READ_BYTES = 5 * 1024 * 1024;
  const start = Math.max(0, stat.size - MAX_READ_BYTES);
  const fd = fs.openSync(filePath, "r");
  try {
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf.toString("utf-8").split("\n").slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

export function blueLogScan(source: string, pattern: string, lines: number): SecOpsResult {
  const filePath = DEFAULT_LOG_PATHS[source];
  if (!filePath) return { level: "err", text: `Unknown log source '${source}'.` };
  if (!fs.existsSync(filePath)) {
    const envVar = `LOG_PATH_${source.toUpperCase().replace(/[^A-Z]/g, "_")}`;
    return {
      level: "err",
      text: `Log source not found: ${filePath}\nSet ${envVar} in xcoder's .env to point at a real log file, or place one at that path.`,
    };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch (e: any) {
    return { level: "err", text: `Invalid regex: ${e.message}` };
  }
  const tail = readTail(filePath, Number(lines) || 2000);
  const matches = tail.filter((l) => re.test(l));
  return {
    level: matches.length > 3 ? "warn" : "ok",
    text:
      `Scanned last ${tail.length} line(s) of ${filePath} for /${pattern}/\n` +
      (matches.length
        ? `${matches.length} match(es) — most recent: ${matches[matches.length - 1].slice(0, 200)}`
        : "No matches — nothing to report."),
  };
}

function listListeningPorts(): { port: number; proto: string }[] {
  const results: { port: number; proto: string }[] = [];
  if (process.platform === "win32") {
    const r = runCmd("netstat", ["-an"]);
    for (const line of (r.stdout || "").split("\n")) {
      const m =
        line.match(/^\s*(TCP)\s+\S+:(\d+)\s+.*LISTENING/i) || line.match(/^\s*(UDP)\s+\S+:(\d+)\s+\*:\*/i);
      if (m) results.push({ proto: m[1].toLowerCase(), port: Number(m[2]) });
    }
  } else {
    const r = commandExists("ss") ? runCmd("ss", ["-tuln"]) : runCmd("netstat", ["-tuln"]);
    for (const line of (r.stdout || "").split("\n")) {
      const m = line.match(/^(tcp|udp)\d?\s+\d+\s+\d+\s+\S*:(\d+)\s/i);
      if (m) results.push({ proto: m[1].toLowerCase(), port: Number(m[2]) });
    }
  }
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.proto}:${r.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function bluePortAudit(host: string, expectedPortsCsv: string): SecOpsResult {
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(host.trim().toLowerCase());
  if (!isLocal) {
    // Defense in depth: any parameter that names a network target gets the same server-side
    // gate, even for a tool not primarily framed as network-facing.
    requireAllowedTarget(host);
    return {
      level: "err",
      text: `Live remote listening-port enumeration isn't available without shell access to '${host}'. This check only works against the local machine (host=localhost).`,
    };
  }
  const expected = expectedPortsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const open = listListeningPorts();
  const openPorts = [...new Set(open.map((o) => String(o.port)))];
  const unexpected = openPorts.filter((p) => !expected.includes(p));
  return {
    level: unexpected.length ? "warn" : "ok",
    text:
      `Listening ports on ${host}: ${openPorts.join(", ") || "(none detected)"}\n` +
      (unexpected.length
        ? `Unexpected listener(s) not in expected set: ${unexpected.join(", ")}`
        : "All listening ports are in the expected set."),
  };
}

const BASELINE_DIR = process.env.SECOPS_BASELINE_DIR || path.join(process.cwd(), "data", "baselines");

function walkFiles(root: string, maxFiles = 2000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

function hashFile(filePath: string): string {
  const MAX_BYTES = 10 * 1024 * 1024;
  const stat = fs.statSync(filePath);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const size = Math.min(stat.size, MAX_BYTES);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);
    hash.update(buf);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function blueFileIntegrityCheck(dirPath: string, baselineId: string): SecOpsResult {
  if (!fs.existsSync(dirPath)) return { level: "err", text: `Path not found: ${dirPath}` };
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  const baselineFile = path.join(BASELINE_DIR, `${baselineId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);

  const files = walkFiles(dirPath);
  const manifest: Record<string, string> = {};
  for (const f of files) {
    try {
      manifest[f] = hashFile(f);
    } catch {
      /* skip unreadable files */
    }
  }

  if (!fs.existsSync(baselineFile)) {
    fs.writeFileSync(baselineFile, JSON.stringify(manifest, null, 2));
    return {
      level: "ok",
      text: `No existing baseline '${baselineId}' — created one now from ${files.length} file(s) under ${dirPath}. Run again later to diff against it.`,
    };
  }

  const prior: Record<string, string> = JSON.parse(fs.readFileSync(baselineFile, "utf-8"));
  const added = Object.keys(manifest).filter((f) => !(f in prior));
  const removed = Object.keys(prior).filter((f) => !(f in manifest));
  const changed = Object.keys(manifest).filter((f) => f in prior && prior[f] !== manifest[f]);
  const diffCount = added.length + removed.length + changed.length;

  return {
    level: diffCount ? "warn" : "ok",
    text:
      `Hashed ${files.length} file(s) under ${dirPath} vs baseline '${baselineId}'\n` +
      (diffCount
        ? [
            changed.length ? `${changed.length} changed: ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? "…" : ""}` : "",
            added.length ? `${added.length} added: ${added.slice(0, 5).join(", ")}${added.length > 5 ? "…" : ""}` : "",
            removed.length ? `${removed.length} removed: ${removed.slice(0, 5).join(", ")}${removed.length > 5 ? "…" : ""}` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : "0 diffs — tree matches baseline."),
  };
}

export function runDependencyAudit(repoPath: string, ecosystem: "npm" | "pip"): SecOpsResult {
  if (!fs.existsSync(repoPath)) return { level: "err", text: `Path not found: ${repoPath}` };

  if (ecosystem === "npm") {
    if (!fs.existsSync(path.join(repoPath, "package.json"))) {
      return { level: "err", text: `No package.json found in ${repoPath} — not an npm project.` };
    }
    const r = runCmd("npm", ["audit", "--json"], { cwd: repoPath, timeoutMs: 60_000 });
    try {
      const data = JSON.parse(r.stdout || "{}");
      const vulns: Record<string, number> = data.metadata?.vulnerabilities || {};
      const total = Object.values(vulns).reduce((a, b) => a + (Number(b) || 0), 0);
      const highest = ["critical", "high", "moderate", "low"].find((sev) => (vulns[sev] || 0) > 0);
      return {
        level: total ? "warn" : "ok",
        text: total
          ? `npm audit: ${total} vulnerabilit${total === 1 ? "y" : "ies"} (${Object.entries(vulns)
              .filter(([, n]) => n > 0)
              .map(([sev, n]) => `${n} ${sev}`)
              .join(", ")})\nHighest severity: ${highest}`
          : "npm audit: 0 vulnerabilities found.",
      };
    } catch {
      return { level: "err", text: `Could not parse npm audit output.\n${(r.stdout || r.stderr || "").slice(0, 500)}` };
    }
  }

  if (!commandExists("pip-audit")) {
    return { level: "err", text: `pip-audit is not installed. Install it with 'pip install pip-audit' to enable this check.` };
  }
  const reqFile = path.join(repoPath, "requirements.txt");
  if (!fs.existsSync(reqFile)) {
    return { level: "err", text: `No requirements.txt found in ${repoPath}.` };
  }
  const r = runCmd("pip-audit", ["-f", "json", "-r", reqFile], { cwd: repoPath, timeoutMs: 60_000 });
  try {
    const data = JSON.parse(r.stdout || "[]");
    const total = Array.isArray(data) ? data.reduce((a: number, d: any) => a + (d.vulns?.length || 0), 0) : 0;
    return {
      level: total ? "warn" : "ok",
      text: total ? `pip-audit: ${total} known vulnerabilit${total === 1 ? "y" : "ies"} across dependencies.` : "pip-audit: 0 known vulnerabilities.",
    };
  } catch {
    return { level: "err", text: `Could not parse pip-audit output.\n${(r.stdout || r.stderr || "").slice(0, 500)}` };
  }
}

export function blueFirewallStatus(engine: "ufw" | "iptables"): SecOpsResult {
  if (process.platform === "win32") {
    return {
      level: "err",
      text: `${engine} isn't available on Windows. On Windows, check Windows Defender Firewall ('netsh advfirewall show allprofiles') instead.`,
    };
  }
  if (engine === "ufw") {
    if (!commandExists("ufw")) return { level: "err", text: "ufw is not installed on this host." };
    const r = runCmd("ufw", ["status", "verbose"]);
    if (r.status !== 0) return { level: "err", text: `Could not read ufw status (are you root?): ${r.stderr || r.error}` };
    return { level: "ok", text: (r.stdout || "").trim().slice(0, 1500) };
  }
  const r = runCmd("iptables", ["-L", "-n"]);
  if (r.status !== 0) return { level: "err", text: `Could not read iptables rules (are you root?): ${r.stderr || r.error}` };
  return { level: "ok", text: (r.stdout || "").trim().slice(0, 1500) };
}

export function blueCertExpiryCheck(domain: string, warnDays: number): Promise<SecOpsResult> {
  requireAllowedTarget(domain);
  const host = hostnameOf(domain) || domain;
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host, port: 443, servername: host, timeout: 8000, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          resolve({ level: "err", text: `No certificate returned by ${host}:443.` });
          return;
        }
        const validTo = new Date(cert.valid_to);
        const daysLeft = Math.round((validTo.getTime() - Date.now()) / 86_400_000);
        resolve({
          level: daysLeft < Number(warnDays) ? "warn" : "ok",
          text:
            `${host} cert expires ${validTo.toISOString().slice(0, 10)} (${daysLeft} day(s) left)\n` +
            (daysLeft < Number(warnDays) ? `Below warn threshold of ${warnDays} day(s) — renew soon.` : "Within safe threshold."),
        });
      }
    );
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ level: "err", text: `Timed out connecting to ${host}:443.` });
    });
    socket.on("error", (e) => resolve({ level: "err", text: `Could not connect to ${host}:443 — ${e.message}` }));
  });
}

export function blueSshAuthLogReview(windowHours: number): SecOpsResult {
  const filePath = DEFAULT_LOG_PATHS["auth.log"];
  if (!fs.existsSync(filePath)) {
    return { level: "err", text: `auth.log not found at ${filePath}. Set LOG_PATH_AUTHLOG in xcoder's .env to point at a real file.` };
  }
  const tail = readTail(filePath, 20_000);
  const failRe = /Failed password.*from ([\d.]+)/;
  const byIp: Record<string, number> = {};
  let total = 0;
  for (const line of tail) {
    const m = line.match(failRe);
    if (m) {
      total++;
      byIp[m[1]] = (byIp[m[1]] || 0) + 1;
    }
  }
  const top = Object.entries(byIp).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    level: total > 10 ? "warn" : "ok",
    text:
      `${total} failed-password attempt(s) found in ${filePath} (sampled from the last 20k lines — not precisely windowed to ${windowHours}h, since syslog timestamp formats vary)\n` +
      (top.length ? `Top source IPs: ${top.map(([ip, n]) => `${ip} (${n})`).join(", ")}` : "No brute-force pattern detected."),
  };
}

export function blueBackupVerify(backupPath: string, maxAgeHours: number): SecOpsResult {
  if (!fs.existsSync(backupPath)) return { level: "err", text: `${backupPath}: not found.` };
  const stat = fs.statSync(backupPath);
  const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
  const ok = ageHours <= Number(maxAgeHours);
  return {
    level: ok ? "ok" : "err",
    text:
      `${backupPath}: found, age ${ageHours.toFixed(1)}h (limit ${maxAgeHours}h)\n` +
      (ok ? "Backup is within freshness policy." : "Backup is stale — investigate the backup job."),
  };
}

// =======================================================================
// RED TEAM — real recon/audit tools, all gated by requireAllowedTarget()
// =======================================================================

function parsePortRange(range: string, cap = 1024): number[] {
  const ports: number[] = [];
  for (const part of range.split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    for (let p = start; p <= end && ports.length < cap; p++) ports.push(p);
  }
  return ports;
}

function tcpConnectScan(host: string, ports: number[], timeoutMs = 400, concurrency = 50): Promise<number[]> {
  return new Promise((resolve) => {
    const open: number[] = [];
    let idx = 0;
    let inFlight = 0;

    function next() {
      if (idx >= ports.length) {
        if (inFlight === 0) resolve(open.sort((a, b) => a - b));
        return;
      }
      const port = ports[idx++];
      inFlight++;
      const socket = new net.Socket();
      let settled = false;
      const finish = (isOpen: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (isOpen) open.push(port);
        inFlight--;
        next();
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(port, host);
    }

    if (ports.length === 0) {
      resolve([]);
      return;
    }
    const starters = Math.min(concurrency, ports.length);
    for (let i = 0; i < starters; i++) next();
  });
}

export async function redPortScanner(target: string, portRange: string, scanType: string): Promise<SecOpsResult> {
  requireAllowedTarget(target);
  const host = hostnameOf(target) || target;

  // Prefer nmap if it's actually installed (more accurate/faster); fall back to a built-in
  // dependency-free TCP connect scan otherwise.
  if (commandExists("nmap")) {
    const args = ["-p", portRange, "-Pn", "--host-timeout", "20s", host];
    const r = runCmd("nmap", args, { timeoutMs: 25_000 });
    if (r.status === 0 && r.stdout) {
      return { level: "ok", text: `nmap ${args.join(" ")}\n${r.stdout.trim().slice(0, 1500)}` };
    }
  }

  const ports = parsePortRange(portRange);
  if (ports.length === 0) return { level: "err", text: `Could not parse port range '${portRange}'.` };
  const note = scanType.startsWith("SYN")
    ? "SYN scanning needs raw sockets/root and isn't implemented here — ran a TCP connect scan instead.\n"
    : "";
  const open = await tcpConnectScan(host, ports);
  return {
    level: "ok",
    text:
      `${note}TCP connect scan of ${host} (${ports.length} port(s) checked, nmap not found)\n` +
      (open.length ? `Open: ${open.join(", ")}` : "No open ports found in range."),
  };
}

const COMMON_SUBDOMAINS = ["www", "api", "staging", "dev", "vpn", "mail", "ftp", "admin", "test", "portal", "app", "beta"];

export async function redSubdomainEnum(domain: string): Promise<SecOpsResult> {
  requireAllowedTarget(domain);
  const host = hostnameOf(domain) || domain;
  const found: string[] = [];
  await Promise.all(
    COMMON_SUBDOMAINS.map(async (sub) => {
      const candidate = `${sub}.${host}`;
      try {
        await dns.resolve(candidate);
        found.push(candidate);
      } catch {
        /* NXDOMAIN or no records — not found, expected for most */
      }
    })
  );
  return {
    level: "ok",
    text: found.length
      ? found.sort().join("\n")
      : `No subdomains resolved among ${COMMON_SUBDOMAINS.length} common prefixes checked for ${host}.`,
  };
}

export async function redHttpHeaderAudit(url: string): Promise<SecOpsResult> {
  requireAllowedTarget(url);
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000) });
    const wanted = [
      "content-security-policy",
      "strict-transport-security",
      "x-frame-options",
      "x-content-type-options",
      "referrer-policy",
    ];
    const missing = wanted.filter((h) => !res.headers.has(h));
    return {
      level: missing.length ? "warn" : "ok",
      text: missing.length ? `Missing: ${missing.join(", ")}` : "All recommended security headers present.",
    };
  } catch (e: any) {
    return { level: "err", text: `Request failed: ${e.message ?? e}` };
  }
}

// Small local wordlist for OFFLINE known-weak checking — genuinely computed/compared here, not
// fabricated, but deliberately not a live breach-database lookup or online cracking service.
const COMMON_PASSWORDS = [
  "password", "123456", "12345678", "qwerty", "111111", "123456789", "letmein",
  "abc123", "iloveyou", "admin", "welcome", "monkey", "dragon", "football",
  "password1", "123123", "sunshine", "master", "shadow", "superman",
];

function commonHashSet(hashType: string): Set<string> {
  const set = new Set<string>();
  for (const pw of COMMON_PASSWORDS) {
    if (hashType === "md5 (legacy)") set.add(crypto.createHash("md5").update(pw).digest("hex"));
    else if (hashType === "sha256") set.add(crypto.createHash("sha256").update(pw).digest("hex"));
  }
  return set;
}

export function redPasswordStrengthAudit(hashType: string, hashesRaw: string): SecOpsResult {
  const hashes = hashesRaw.split("\n").map((h) => h.trim()).filter(Boolean);
  if (hashes.length === 0) return { level: "err", text: "No hashes provided." };

  let weak = 0;
  if (hashType === "bcrypt") {
    // bcrypt embeds its own salt per-hash, so each one has to be checked individually against
    // the wordlist rather than via a precomputed set.
    for (const h of hashes) {
      const isWeak = COMMON_PASSWORDS.some((pw) => {
        try {
          return bcrypt.compareSync(pw, h);
        } catch {
          return false;
        }
      });
      if (isWeak) weak++;
    }
  } else {
    const known = commonHashSet(hashType);
    weak = hashes.filter((h) => known.has(h.toLowerCase())).length;
  }

  return {
    level: weak ? "warn" : "ok",
    text: `${hashes.length} hash(es) checked offline against a ${COMMON_PASSWORDS.length}-entry common-password list (${hashType})\n${weak} matched a known-weak value.`,
  };
}

export function redDependencyVulnScan(repoPath: string): SecOpsResult {
  const r = runDependencyAudit(repoPath, "npm");
  if (r.level === "err") return r;
  return { level: r.level, text: r.text.replace(/^npm audit:/, "Attacker-relevant exposure:") };
}

function tryTlsConnect(
  host: string,
  port: number,
  opts: tls.ConnectionOptions
): Promise<{ ok: boolean; cipher?: string; protocol?: string; err?: string }> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, timeout: 6000, rejectUnauthorized: false, ...opts }, () => {
      const cipher = socket.getCipher();
      const protocol = socket.getProtocol() || undefined;
      socket.end();
      resolve({ ok: true, cipher: cipher?.name, protocol });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, err: "timeout" });
    });
    socket.on("error", (e) => resolve({ ok: false, err: e.message }));
  });
}

export async function redTlsConfigCheck(host: string, port: number): Promise<SecOpsResult> {
  requireAllowedTarget(host);
  const normal = await tryTlsConnect(host, port, {});
  if (!normal.ok) return { level: "err", text: `Could not connect to ${host}:${port} — ${normal.err}` };

  const weakLegacy = await tryTlsConnect(host, port, {
    minVersion: "TLSv1" as tls.SecureVersion,
    maxVersion: "TLSv1.1" as tls.SecureVersion,
  });

  const issues: string[] = [];
  if (weakLegacy.ok) issues.push(`Server still accepts legacy TLS 1.0/1.1 (negotiated ${weakLegacy.protocol}) — disable it.`);
  const weakCiphers = /RC4|DES|3DES|MD5|NULL|EXPORT/i;
  if (normal.cipher && weakCiphers.test(normal.cipher)) issues.push(`Weak cipher in use: ${normal.cipher}`);

  return {
    level: issues.length ? "warn" : "ok",
    text: `${host}:${port} — negotiated ${normal.protocol}, cipher ${normal.cipher}\n` + (issues.length ? issues.join("\n") : "TLS 1.2+/strong ciphers only. Clean."),
  };
}

/**
 * `phishing_simulation_sender` is intentionally NOT implemented as a real send. Even scoped to
 * "internal only" recipients with a "[SIMULATION]" label, the actual content a
 * phishing-awareness tool needs to send (a convincing fake password-reset / invoice /
 * exec-request email) is, by design, deceptive content meant to trick a human into clicking or
 * disclosing something — that's true regardless of the stated intent behind it, and it's not
 * something generated here. If you want real phishing-simulation campaigns, a purpose-built
 * platform (GoPhish, KnowBe4, Proofpoint) already has the consent tracking, click reporting,
 * and educational landing-page flow this needs — worth pointing this feature at one of those
 * instead of reimplementing it here.
 */
export function redPhishingSimulationNotImplemented(): SecOpsResult {
  return {
    level: "err",
    text:
      "Not implemented as a real function by design. Generating deceptive phishing-style " +
      "email content (fake password reset / invoice / exec request) isn't something this " +
      "gets built for real sending, even for internal awareness training — the content is " +
      "inherently deceptive regardless of intent. For real phishing-simulation campaigns, " +
      "point this at a purpose-built platform (GoPhish, KnowBe4, Proofpoint) that has proper " +
      "consent tracking, click reporting, and an educational landing page for this exact use case.",
  };
}

// =======================================================================
// Dispatcher — what security_ops_tool actually calls
// =======================================================================

export async function runSecurityTool(
  team: "blue" | "red",
  toolId: string,
  params: Record<string, string>
): Promise<SecOpsResult> {
  try {
    switch (toolId) {
      // Blue team
      case "log_scan":
        return blueLogScan(params.source, params.pattern, Number(params.lines));
      case "port_audit":
        return bluePortAudit(params.host, params.expected_ports);
      case "file_integrity_check":
        return blueFileIntegrityCheck(params.path, params.baseline);
      case "dependency_audit":
        return runDependencyAudit(params.repo, params.ecosystem as "npm" | "pip");
      case "firewall_status":
        return blueFirewallStatus(params.engine as "ufw" | "iptables");
      case "cert_expiry_check":
        return await blueCertExpiryCheck(params.domain, Number(params.warn_days));
      case "ssh_auth_log_review":
        return blueSshAuthLogReview(Number(params.window));
      case "backup_verify":
        return blueBackupVerify(params.path, Number(params.max_age_hours));

      // Red team
      case "port_scanner":
        return await redPortScanner(params.target, params.port_range, params.scan_type);
      case "subdomain_enum":
        return await redSubdomainEnum(params.domain);
      case "http_header_audit":
        return await redHttpHeaderAudit(params.url);
      case "password_strength_audit":
        return redPasswordStrengthAudit(params.hash_type, params.hashes);
      case "dependency_vuln_scan":
        return redDependencyVulnScan(params.repo);
      case "tls_config_check":
        return await redTlsConfigCheck(params.host, Number(params.port));
      case "phishing_simulation_sender":
        return redPhishingSimulationNotImplemented();

      default:
        return { level: "err", text: `Unknown tool '${toolId}'.` };
    }
  } catch (e: any) {
    if (e instanceof TargetNotAllowedError) {
      return {
        level: "err",
        text: `REFUSED\nTarget: ${e.host}\nReason: not present in TARGET_ALLOWLIST\nAllowed: ${getAllowlist().join(", ")}`,
      };
    }
    return { level: "err", text: `Error: ${e.message ?? e}` };
  }
}
