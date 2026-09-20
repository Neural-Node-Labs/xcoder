import { useState, useEffect } from "react";
import { usePageActive, useOnActivate } from "../context/PageActive";
import { api, SecOpsResult } from "../api/client";
import { useAuth } from "../context/AuthContext";

/**
 * Frontend catalog mirroring runSecurityTool's dispatcher in src/tools/securityOpsTool.ts.
 * Purely descriptive — the server is the real source of truth on which toolIds/params exist;
 * this just drives which form fields to render before submitting.
 */
interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
}
interface ToolDef {
  id: string;
  label: string;
  description: string;
  fields: FieldDef[];
  /** True if this tool can reach out over the network to a named target, so it's subject to
   *  the TARGET_ALLOWLIST gate below. */
  networked?: boolean;
}

const BLUE_TOOLS: ToolDef[] = [
  {
    id: "log_scan",
    label: "Log scan",
    description: "Regex-scan the tail of a known log file (syslog, auth.log, app.log, nginx access).",
    fields: [
      { key: "source", label: "Log source", defaultValue: "app.log", placeholder: "syslog | auth.log | app.log | nginx access" },
      { key: "pattern", label: "Pattern (regex)", placeholder: "failed|denied|error" },
      { key: "lines", label: "Lines to scan", defaultValue: "2000" },
    ],
  },
  {
    id: "port_audit",
    label: "Port audit",
    description: "List locally listening TCP/UDP ports and flag anything outside an expected set. Local machine only.",
    fields: [
      { key: "host", label: "Host", defaultValue: "localhost" },
      { key: "expected_ports", label: "Expected ports (comma-separated)", placeholder: "22,80,443" },
    ],
  },
  {
    id: "file_integrity_check",
    label: "File integrity check",
    description: "SHA-256 baseline a directory, or diff it against a previously saved baseline.",
    fields: [
      { key: "path", label: "Directory path", placeholder: "/app/src" },
      { key: "baseline", label: "Baseline id", placeholder: "prod-src" },
    ],
  },
  {
    id: "dependency_audit",
    label: "Dependency audit",
    description: "Runs npm audit / pip-audit against a real repo path.",
    fields: [
      { key: "repo", label: "Repo path", placeholder: "." },
      { key: "ecosystem", label: "Ecosystem", defaultValue: "npm", placeholder: "npm | pip" },
    ],
  },
  {
    id: "firewall_status",
    label: "Firewall status",
    description: "Reads ufw or iptables rule state on the local host.",
    fields: [{ key: "engine", label: "Engine", defaultValue: "ufw", placeholder: "ufw | iptables" }],
  },
  {
    id: "cert_expiry_check",
    label: "Certificate expiry check",
    description: "Connects to a domain over TLS and reports days until certificate expiry.",
    fields: [
      { key: "domain", label: "Domain", placeholder: "example.com" },
      { key: "warn_days", label: "Warn threshold (days)", defaultValue: "30" },
    ],
    networked: true,
  },
  {
    id: "ssh_auth_log_review",
    label: "SSH auth log review",
    description: "Summarizes recent failed/successful SSH auth attempts from the local auth log.",
    fields: [{ key: "window", label: "Window (hours)", defaultValue: "24" }],
  },
  {
    id: "backup_verify",
    label: "Backup freshness",
    description: "Checks that a backup path exists and was modified within a max age.",
    fields: [
      { key: "path", label: "Backup path", placeholder: "/var/backups/xcoder" },
      { key: "max_age_hours", label: "Max age (hours)", defaultValue: "24" },
    ],
  },
];

const RED_TOOLS: ToolDef[] = [
  {
    id: "port_scanner",
    label: "Port scanner",
    description: "TCP connect scan against an allowlisted target (prefers real nmap if installed).",
    fields: [
      { key: "target", label: "Target", placeholder: "localhost" },
      { key: "port_range", label: "Port range", defaultValue: "1-1024" },
      { key: "scan_type", label: "Scan type", defaultValue: "connect" },
    ],
    networked: true,
  },
  {
    id: "subdomain_enum",
    label: "Subdomain enumeration",
    description: "Enumerates subdomains of an allowlisted domain via DNS.",
    fields: [{ key: "domain", label: "Domain", placeholder: "example.com" }],
    networked: true,
  },
  {
    id: "http_header_audit",
    label: "HTTP security header audit",
    description: "Fetches a URL and flags missing recommended security headers.",
    fields: [{ key: "url", label: "URL", placeholder: "https://example.com" }],
    networked: true,
  },
  {
    id: "password_strength_audit",
    label: "Password strength audit",
    description: "Offline check of hashes against a small known-weak wordlist. Nothing is sent anywhere.",
    fields: [
      { key: "hash_type", label: "Hash type", defaultValue: "bcrypt", placeholder: "bcrypt | sha256 | md5 (legacy)" },
      { key: "hashes", label: "Hashes (one per line)", placeholder: "$2a$10$..." },
    ],
  },
  {
    id: "dependency_vuln_scan",
    label: "Dependency vulnerability scan",
    description: "Same engine as Blue Team's dependency audit, framed for attacker-relevant exposure.",
    fields: [{ key: "repo", label: "Repo path", placeholder: "." }],
  },
  {
    id: "tls_config_check",
    label: "TLS config check",
    description: "Probes an allowlisted host:port for legacy TLS versions and weak ciphers.",
    fields: [
      { key: "host", label: "Host", placeholder: "example.com" },
      { key: "port", label: "Port", defaultValue: "443" },
    ],
    networked: true,
  },
  {
    id: "phishing_simulation_sender",
    label: "Phishing simulation sender",
    description: "Not implemented by design — deceptive email content isn't generated here regardless of stated intent. Point real campaigns at GoPhish / KnowBe4 / Proofpoint instead.",
    fields: [],
  },
];

const LEVEL_BADGE: Record<SecOpsResult["level"], string> = {
  ok: "badge-green",
  warn: "badge-amber",
  err: "badge-red",
};

export function SecurityOpsPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  const [team, setTeam] = useState<"blue" | "red">("blue");
  const catalog = team === "blue" ? BLUE_TOOLS : RED_TOOLS;
  const [toolId, setToolId] = useState(catalog[0].id);
  const tool = catalog.find((t) => t.id === toolId) ?? catalog[0];

  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SecOpsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [allowlist, setAllowlistState] = useState<string[]>([]);
  const [loadingAllowlist, setLoadingAllowlist] = useState(true);
  const [newTarget, setNewTarget] = useState("");
  const [allowlistBusy, setAllowlistBusy] = useState(false);

  function refreshAllowlist() {
    setLoadingAllowlist(true);
    api.securityOpsAllowlist().then((r) => setAllowlistState(r.allowlist)).finally(() => setLoadingAllowlist(false));
  }

  useEffect(() => {
    refreshAllowlist();
  }, []);
  useOnActivate(refreshAllowlist);

  function switchTeam(next: "blue" | "red") {
    setTeam(next);
    const first = (next === "blue" ? BLUE_TOOLS : RED_TOOLS)[0];
    setToolId(first.id);
    setValues({});
    setResult(null);
    setError(null);
  }

  function switchTool(id: string) {
    setToolId(id);
    setValues({});
    setResult(null);
    setError(null);
  }

  function fieldValue(f: FieldDef): string {
    return values[f.key] ?? f.defaultValue ?? "";
  }

  async function runTool(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    const params: Record<string, string> = {};
    for (const f of tool.fields) params[f.key] = fieldValue(f);
    try {
      const r = await api.runSecurityOpsTool(team, tool.id, params);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addTarget(e: React.FormEvent) {
    e.preventDefault();
    const host = newTarget.trim().toLowerCase();
    if (!host) return;
    setAllowlistBusy(true);
    try {
      const r = await api.updateSecurityOpsAllowlist([...allowlist, host]);
      setAllowlistState(r.allowlist);
      setNewTarget("");
    } finally {
      setAllowlistBusy(false);
    }
  }

  async function removeTarget(host: string) {
    setAllowlistBusy(true);
    try {
      const r = await api.updateSecurityOpsAllowlist(allowlist.filter((h) => h !== host));
      setAllowlistState(r.allowlist);
    } finally {
      setAllowlistBusy(false);
    }
  }

  const ALWAYS_ALLOWED = new Set(["localhost", "127.0.0.1", "::1"]);

  return (
    <div className="grid grid-2" style={{ alignItems: "start" }}>
      <div className="card">
        <div className="row-between" style={{ marginBottom: 12 }}>
          <div className="card-title" style={{ margin: 0 }}>
            Run a check
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className={`btn btn-sm ${team === "blue" ? "btn-primary" : "btn-ghost"}`} onClick={() => switchTeam("blue")}>
              Blue Team
            </button>
            <button className={`btn btn-sm ${team === "red" ? "btn-primary" : "btn-ghost"}`} onClick={() => switchTeam("red")}>
              Red Team
            </button>
          </div>
        </div>

        <div className="field">
          <label>Check</label>
          <select value={toolId} onChange={(e) => switchTool(e.target.value)}>
            {catalog.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="field-hint">{tool.description}</div>
        </div>

        {tool.networked && (
          <div className="text-2" style={{ fontSize: 11, marginBottom: 10 }}>
            Refused unless the target is on the allowlist to the right (localhost is always allowed).
          </div>
        )}

        {tool.id === "phishing_simulation_sender" ? (
          <button className="btn btn-ghost" disabled>
            Not implemented
          </button>
        ) : (
          <form onSubmit={runTool}>
            {tool.fields.map((f) => (
              <div className="field" key={f.key}>
                <label>{f.label}</label>
                <input
                  value={fieldValue(f)}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </div>
            ))}
            <button className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" /> : "Run"}
            </button>
          </form>
        )}

        {error && (
          <div className="badge badge-red" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        {result && (
          <div style={{ marginTop: 14 }}>
            <span className={`badge ${LEVEL_BADGE[result.level]}`} style={{ marginBottom: 8 }}>
              {result.level.toUpperCase()}
            </span>
            <pre className="mono" style={{ whiteSpace: "pre-wrap", marginTop: 8, fontSize: 12 }}>
              {result.text}
            </pre>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Target allowlist</div>
        <div className="text-2" style={{ fontSize: 11, marginBottom: 12 }}>
          Every Red Team action that names a network target (plus Blue Team's certificate expiry check) is refused
          server-side unless the target's hostname exactly matches, or is a subdomain of, an entry here. This is a
          strict allowlist, not a denylist — nothing is reachable until an admin adds it.
        </div>

        {loadingAllowlist && (
          <div className="row text-2">
            <span className="spinner" /> Loading…
          </div>
        )}

        {!loadingAllowlist && (
          <div className="tool-list">
            {allowlist.map((host) => (
              <div className="tool-row" key={host}>
                <div className="tool-row-name mono">{host}</div>
                {ALWAYS_ALLOWED.has(host) ? (
                  <span className="badge">always allowed</span>
                ) : (
                  isAdmin && (
                    <button className="btn btn-sm btn-danger" onClick={() => removeTarget(host)} disabled={allowlistBusy}>
                      Remove
                    </button>
                  )
                )}
              </div>
            ))}
          </div>
        )}

        {isAdmin ? (
          <form onSubmit={addTarget} style={{ marginTop: 12 }}>
            <div className="field">
              <label>Add target</label>
              <input
                value={newTarget}
                onChange={(e) => setNewTarget(e.target.value)}
                placeholder="staging.example.com"
              />
              <div className="field-hint">Hostname only — no scheme or path.</div>
            </div>
            <button className="btn btn-sm btn-primary" disabled={allowlistBusy || !newTarget.trim()}>
              {allowlistBusy ? <span className="spinner" /> : "Add"}
            </button>
          </form>
        ) : (
          <div className="text-2" style={{ fontSize: 11, marginTop: 10 }}>
            Ask an admin to add a target.
          </div>
        )}
      </div>
    </div>
  );
}
