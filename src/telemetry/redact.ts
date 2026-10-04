/**
 * Secret redaction for anything that leaves the process boundary or lands in a durable
 * artifact: OpenTelemetry span attributes/events, SDLC checkpoint files, rejection reports.
 *
 * Best-effort pattern matching, not a guarantee — it exists so that an API key echoed by a
 * failing command or a pasted deploy log doesn't get exported to a third-party collector or
 * committed to a report file. Pure and total: never throws.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]"],
  // key=value / key: value forms for obviously sensitive key names
  [
    /\b((?:[A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization))\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi,
    "$1[REDACTED]",
  ],
  // credentials embedded in URLs: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[REDACTED]@"],
];

export function redactSecrets(input: unknown): string {
  let s: string;
  try {
    s = typeof input === "string" ? input : input instanceof Error ? `${input.message}` : JSON.stringify(input) ?? String(input);
  } catch {
    s = String(input);
  }
  for (const [re, repl] of PATTERNS) s = s.replace(re, repl);
  return s;
}

/** Redact then cap length — for span attributes/events where unbounded payloads are costly. */
export function redactAndTruncate(input: unknown, max = 500): string {
  const s = redactSecrets(input);
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}
