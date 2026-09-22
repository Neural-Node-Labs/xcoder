import { useId } from "react";

/**
 * xcoder's logomark: a circuit-board "X" — two chamfered bars crossing at a center chip-pad,
 * with small pin pads at each of the four tips — layered over a faint neural/node network and
 * a larger, softer watermark "X" rotated behind it. Reads as "coder" (circuit/chip motif) and
 * "AI" (the node network) at once, built entirely from the app's existing cyan-accent theme
 * variables (see styles.css's "Themes" block) so it recolors automatically with whichever
 * theme is active — Hologram, Ember, or Daylight (see theme.ts) — with no changes here.
 *
 * Self-contained (own ring, own background), so it drops into .brand-mark (Sidebar, LoginPage)
 * as-is, but also works anywhere else full-size — a favicon, a README, a loading screen.
 */
export function XcoderLogo({ size = 30 }: { size?: number }) {
  // Unique per instance: two SVG <defs> ids referenced via url(#...) would otherwise collide if
  // this component is ever rendered more than once on the same page at the same time (it isn't
  // today — Sidebar and LoginPage are never both mounted — but nothing here should depend on
  // that staying true).
  const uid = useId();
  const bgId = `xcoder-logo-bg-${uid}`;
  const clipId = `xcoder-logo-clip-${uid}`;

  return (
    <svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label="xcoder">
      <defs>
        <radialGradient id={bgId} cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="var(--bg-3)" />
          <stop offset="100%" stopColor="var(--bg-0)" />
        </radialGradient>
        {/* Keeps the background X's extended tips (drawn past the ring on purpose, so it reads
            as a distinct second X) from bleeding onto the page behind this badge. */}
        <clipPath id={clipId}>
          <circle cx="32" cy="32" r="30.5" />
        </clipPath>
      </defs>

      <circle cx="32" cy="32" r="30.5" fill={`url(#${bgId})`} stroke="var(--cyan)" strokeWidth="1.5" />

      <g clipPath={`url(#${clipId})`}>
        {/* Background watermark X — the larger, softer "X in the background" layer, rotated and
            extended past the ring so it reads as a distinct second X rather than disappearing
            under the foreground one. */}
        <g opacity="0.3" stroke="var(--cyan)" strokeWidth="5" strokeLinecap="round">
          <line x1="8" y1="8" x2="56" y2="56" transform="rotate(22.5 32 32)" />
          <line x1="56" y1="8" x2="8" y2="56" transform="rotate(22.5 32 32)" />
        </g>

        {/* Faint neural / node-graph abstract — the "AI abstract" backdrop, scattered so it
            doesn't read as a grid or a chart, just a loose network. */}
        <g opacity="0.4" fill="var(--cyan)">
          <circle cx="14" cy="20" r="1.6" />
          <circle cx="21" cy="12" r="1.3" />
          <circle cx="48" cy="16" r="1.6" />
          <circle cx="54" cy="26" r="1.3" />
          <circle cx="12" cy="42" r="1.3" />
          <circle cx="17" cy="51" r="1.6" />
          <circle cx="47" cy="49" r="1.3" />
          <circle cx="53" cy="40" r="1.6" />
        </g>
        <g opacity="0.28" stroke="var(--cyan)" strokeWidth="0.75">
          <line x1="14" y1="20" x2="21" y2="12" />
          <line x1="48" y1="16" x2="54" y2="26" />
          <line x1="12" y1="42" x2="17" y2="51" />
          <line x1="47" y1="49" x2="53" y2="40" />
          <line x1="14" y1="20" x2="12" y2="42" />
          <line x1="48" y1="16" x2="53" y2="40" />
        </g>

        {/* Foreground logomark — the crisp "overlay X at the center", chamfered like a circuit
            trace, with small chip-pad tips and a center node where the two bars cross. */}
        <g fill="var(--cyan)">
          <rect x="10" y="28.5" width="44" height="7" rx="2" transform="rotate(45 32 32)" />
          <rect x="10" y="28.5" width="44" height="7" rx="2" transform="rotate(-45 32 32)" />
          <rect x="29" y="29" width="6" height="6" transform="rotate(45 32 32)" />
          {[
            [17.5, 17.5],
            [46.5, 17.5],
            [17.5, 46.5],
            [46.5, 46.5],
          ].map(([cx, cy]) => (
            <rect key={`${cx}-${cy}`} x={cx - 2.6} y={cy - 2.6} width="5.2" height="5.2" rx="1" transform={`rotate(45 ${cx} ${cy})`} />
          ))}
        </g>
      </g>
    </svg>
  );
}
