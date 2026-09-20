import { useState, useEffect } from "react";
import { usePageActive, useOnActivate } from "../context/PageActive";
import { api, SkillListEntry } from "../api/client";

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  function load() {
    api
      .skills()
      .then(setSkills)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);
  useOnActivate(load);

  const filtered = skills.filter(
    (s) =>
      !filter ||
      s.name.toLowerCase().includes(filter.toLowerCase()) ||
      s.role.toLowerCase().includes(filter.toLowerCase()) ||
      s.triggers.some((t) => t.toLowerCase().includes(filter.toLowerCase()))
  );

  return (
    <div>
      <div className="card">
        <div className="row-between" style={{ marginBottom: 14 }}>
          <div className="card-title" style={{ margin: 0 }}>
            Skills catalog
          </div>
          <input style={{ width: 260 }} placeholder="Filter by name, role, or trigger…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>

        {loading && (
          <div className="row text-2">
            <span className="spinner" /> Loading…
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">◈</div>
            No skills match "{filter}".
          </div>
        )}

        <div className="grid grid-3">
          {filtered.map((s) => (
            <div className="card" key={s.name} style={{ margin: 0 }}>
              <div className="row-between" style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{s.name}</span>
                <span className="badge badge-purple">{s.role}</span>
              </div>
              <div className="text-1" style={{ fontSize: 12, marginBottom: 10 }}>
                {s.description}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {s.triggers.slice(0, 6).map((t) => (
                  <span key={t} className="badge" style={{ fontSize: 10 }}>
                    {t}
                  </span>
                ))}
              </div>
              {s.composes_with.length > 0 && (
                <div className="text-2" style={{ fontSize: 11, marginTop: 10 }}>
                  Composes with: {s.composes_with.join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
