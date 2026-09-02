const ENGINE_COLORS: Record<string, string> = {
  sdlc: "badge-accent",
  react: "badge-blue",
  lean: "badge-blue",
  simple: "badge-blue",
  swarm: "badge-purple",
  agentic: "badge-purple",
  brain: "badge-purple",
  procedure: "badge-purple",
};

export function EngineBadge({ engine, isDefault }: { engine: string; isDefault?: boolean }) {
  const cls = ENGINE_COLORS[engine] ?? "badge";
  return (
    <span className={`badge ${cls}`}>
      {engine}
      {isDefault ? " · default" : ""}
    </span>
  );
}

const STATUS_COLORS: Record<string, string> = {
  completed: "badge-green",
  pending: "badge",
  in_progress: "badge-blue",
  failed: "badge-red",
  escalated: "badge-red",
  skipped: "badge-amber",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${STATUS_COLORS[status] ?? "badge"}`}>
      <span className="badge-dot" />
      {status.replace("_", " ")}
    </span>
  );
}

export function HealthScore({ score }: { score: number }) {
  const color = score >= 80 ? "var(--green)" : score >= 50 ? "var(--amber)" : "var(--red)";
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className="progress-bar-track" style={{ width: 80 }}>
        <div className="progress-bar-fill" style={{ width: `${score}%`, background: color }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color }}>{score}</span>
    </div>
  );
}
