import type { FeatureInfo } from "../api/client";

/** Switch list shared by the SaaS admin (platform + per-tenant) and tenant admin screens. */
export function FeatureSwitches({ features, mode, onToggle, busy }: {
  features: FeatureInfo[]; mode: "platform" | "tenant-owner" | "tenant-admin"; onToggle: (id: string, enabled: boolean) => void; busy?: boolean;
}) {
  return (
    <table>
      <thead><tr><th>Feature</th><th>Status</th><th></th></tr></thead>
      <tbody>
        {features.map((f) => {
          const on = mode === "platform" ? f.platformEnabled : (f.tenantEnabled ?? false);
          const locked = mode === "platform" ? f.platformLocked : mode === "tenant-admin" ? !f.canTenantToggle || (!on && f.sensitive) || !f.platformEnabled : f.platformOnly;
          const why = mode === "platform" && f.platformLocked ? "Locked by an environment variable"
            : mode === "tenant-admin" && !on && f.sensitive ? "Only the SaaS owner can enable this"
            : mode === "tenant-admin" && !f.platformEnabled ? "Disabled platform-wide" : f.platformOnly && mode !== "platform" ? "Platform feature" : "";
          return (
            <tr key={f.id}>
              <td><div style={{ fontWeight: 600 }}>{f.label} {f.sensitive && <span className="badge badge-amber">sensitive</span>} {f.platformOnly && <span className="badge badge-purple">platform only</span>}</div>
                <div className="text-2" style={{ fontSize: 12 }}>{f.description}</div></td>
              <td><span className={`badge ${on ? "badge-green" : ""}`}>{on ? "On" : "Off"}</span>{mode !== "platform" && !f.platformEnabled && <span className="badge badge-red" style={{ marginLeft: 6 }}>off platform-wide</span>}</td>
              <td style={{ textAlign: "right" }}>
                <button className="btn btn-sm" disabled={busy || locked} title={why} aria-label={`${on ? "Disable" : "Enable"} ${f.label}`} onClick={() => onToggle(f.id, !on)}>{on ? "Disable" : "Enable"}</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
