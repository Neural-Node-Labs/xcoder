import { useEffect, useRef, useState } from 'react';

export type HologramTheme = 'classic' | 'superman' | 'danger-red' | 'goku' | 'raider' | 'kraken';

export interface HologramProps {
  size?: number;
  theme?: HologramTheme;
  status?: string;
  thinking?: boolean;
  responseText?: string;
  onThemeChange?: (theme: HologramTheme) => void;
  /** Display name shown by the "classic" theme (see THEMES.classic — the assistant's own
   *  default persona skin, as opposed to the other themes which are named after unrelated
   *  characters/franchises on purpose). Defaults to DEFAULT_ASSISTANT_NAME from
   *  assistantName.ts; callers that already have the configured name (see useAssistantName())
   *  should pass it through so this stays in sync with Settings instead of showing a stale
   *  default. */
  assistantName?: string;
  /** Hides the theme-picker button row — used when embedding the hologram inside a fixed layout
   *  (e.g. the Chat header) where switching themes isn't a feature that page wants to expose. */
  showThemeSelector?: boolean;
  /**
   * Renders the typewriter readout box under the emblem.
   *
   * Defaults to false, which is the opposite of how this started, because having it on is what
   * made the Chat tab look broken: the readout typed out a trimmed copy of the assistant's
   * reply while the identical reply was also rendering in the chat bubble directly beneath it.
   * Every answer appeared twice, once truncated. The hologram's job is presence and status —
   * is it online, is it thinking — not to restate content that already has a home on screen.
   *
   * Left as a prop rather than deleted so the emblem is still reusable somewhere with no other
   * surface for its text.
   */
  showReadout?: boolean;
  /** Extra height for the emblem's glow to bleed into, in px. Lets the caller reserve space so
   *  the soft edges fade into the page instead of being clipped by the next element. */
  bleed?: number;
}

interface ThemeConfig {
  name: string;
  subtitle: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  glowId: string;
  fontFamily: string;
  bgGradient: string;
}

const THEMES: Record<HologramTheme, ThemeConfig> = {
  // Display name for this one is computed at render time from the `assistantName` prop (see
  // below) rather than fixed here — this is the assistant's own default persona skin, not a
  // reference to some other character, so it should say whatever the assistant is actually
  // named. This entry's `name` is just the fallback for when no assistantName prop is passed.
  'classic': {
    name: 'XCODER AI CLASSIC',
    subtitle: 'S I G N A L   C O R E   H U D',
    primaryColor: '#00f3ff',
    secondaryColor: '#00a8ff',
    accentColor: '#ffffff',
    glowId: 'glow-classic',
    fontFamily: '"Share Tech Mono", monospace',
    bgGradient: 'radial-gradient(circle, rgba(0,243,255,0.18) 0%, rgba(0,168,255,0.05) 70%, transparent 100%)',
  },
  superman: {
    name: 'HOUSE OF EL',
    subtitle: 'K R Y P T O N I A N   A R C H I V E S',
    primaryColor: '#e60000',
    secondaryColor: '#ffcc00',
    accentColor: '#0055ff',
    glowId: 'glow-superman',
    fontFamily: '"Orbitron", "Cinzel", sans-serif',
    bgGradient: 'radial-gradient(circle, rgba(230,0,0,0.15) 0%, rgba(0,85,255,0.05) 70%, transparent 100%)',
  },
  'danger-red': {
    name: 'THREAT RED PROTOCOL',
    subtitle: 'D A N G E R   O V E R R I D E   A C T I V E',
    primaryColor: '#ff2a00',
    secondaryColor: '#ff9900',
    accentColor: '#ffe600',
    glowId: 'glow-danger-red',
    fontFamily: '"Share Tech Mono", monospace',
    bgGradient: 'radial-gradient(circle, rgba(255,42,0,0.2) 0%, rgba(255,153,0,0.05) 70%, transparent 100%)',
  },
  goku: {
    name: 'SAIYAN SCOUTER v9.2',
    subtitle: 'P O W E R   L E V E L :   > 9 0 0 0',
    primaryColor: '#00ff66',
    secondaryColor: '#ffaa00',
    accentColor: '#00ffff',
    glowId: 'glow-goku',
    fontFamily: '"VT323", "Courier New", monospace',
    bgGradient: 'radial-gradient(circle, rgba(0,255,102,0.15) 0%, rgba(255,170,0,0.05) 70%, transparent 100%)',
  },
  raider: {
    name: 'RAIDER TACTICAL HUD',
    subtitle: 'S A T E L L I T E   T R A C K I N G   L O C K',
    primaryColor: '#ff0055',
    secondaryColor: '#7000ff',
    accentColor: '#00ffff',
    glowId: 'glow-raider',
    fontFamily: '"Rajdhani", sans-serif',
    bgGradient: 'radial-gradient(circle, rgba(255,0,85,0.18) 0%, rgba(112,0,255,0.08) 70%, transparent 100%)',
  },
  kraken: {
    name: 'ABYSS PROTOCOL - KRAKEN',
    subtitle: 'B A T H Y A L   D E E P   S C A N N E R',
    primaryColor: '#00ffaa',
    secondaryColor: '#005577',
    accentColor: '#00f3ff',
    glowId: 'glow-kraken',
    fontFamily: '"Teko", sans-serif',
    bgGradient: 'radial-gradient(circle, rgba(0,255,170,0.18) 0%, rgba(0,85,119,0.1) 70%, transparent 100%)',
  },
};

export function Hologram({
  size = 500,
  theme = 'classic',
  status = 'ONLINE',
  thinking = false,
  responseText = '',
  onThemeChange,
  assistantName = 'Xcoder AI',
  showThemeSelector = true,
  showReadout = false,
  bleed = 0,
}: HologramProps) {
  const [currentTheme, setCurrentTheme] = useState<HologramTheme>(theme);
  const [typed, setTyped] = useState(responseText);
  const timerRef = useRef<number | null>(null);

  const active = THEMES[currentTheme];
  // Only the "classic" theme's name is dynamic — it's the assistant's own default persona, so
  // it should say whatever the assistant is actually named (see the assistantName prop's doc
  // comment above); every other theme is deliberately a different, fixed character/franchise
  // skin the user opted into, which this doesn't touch.
  const displayName = currentTheme === 'classic' ? `${assistantName.toUpperCase()} CLASSIC` : active.name;

  useEffect(() => {
    setCurrentTheme(theme);
  }, [theme]);

  // Typewriter effect. Skipped entirely when the readout isn't rendered — otherwise this keeps
  // a 18ms interval running and re-rendering the component for text nobody can see.
  useEffect(() => {
    if (!showReadout || thinking) return;
    if (timerRef.current) window.clearInterval(timerRef.current);
    let i = 0;
    setTyped('');
    timerRef.current = window.setInterval(() => {
      i++;
      setTyped(responseText.slice(0, i));
      if (i >= responseText.length && timerRef.current) {
        window.clearInterval(timerRef.current);
      }
    }, 18);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [responseText, thinking, showReadout]);

  const handleSelectTheme = (t: HologramTheme) => {
    setCurrentTheme(t);
    if (onThemeChange) onThemeChange(t);
  };

  return (
    <div
      style={{
        width: '100%',
        maxWidth: size,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        fontFamily: active.fontFamily,
        color: active.primaryColor,
        // No background, border-radius, padding or overflow:hidden here any more. Those drew
        // the emblem as a distinct rounded card pasted on top of the page, with a visible seam
        // where the gradient's rounded corners met the surrounding layout. The glow now lives
        // in an absolutely-positioned layer below, radially masked so it fades to nothing
        // before reaching any edge — nothing to clip, so nothing to see a seam against.
        boxSizing: 'border-box',
        position: 'relative',
        paddingBottom: bleed,
        transition: 'color 0.5s ease',
      }}
    >
      {/* Ambient glow. Sits behind everything, oversized and radially faded, so the emblem
          reads as lit-from-within rather than as a panel with edges. pointerEvents none so it
          never intercepts clicks meant for the controls above it. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: '140%',
          height: '140%',
          background: active.bgGradient,
          filter: 'blur(6px)',
          opacity: thinking ? 1 : 0.75,
          pointerEvents: 'none',
          zIndex: 0,
          transition: 'opacity 0.6s ease, background 0.5s ease',
        }}
      />

      {/* Theme Selector Buttons */}
      {showThemeSelector && (
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
          justifyContent: 'center',
          marginBottom: '15px',
          zIndex: 10,
        }}
      >
        {(Object.keys(THEMES) as HologramTheme[]).map((t) => (
          <button
            key={t}
            onClick={() => handleSelectTheme(t)}
            style={{
              background: currentTheme === t ? THEMES[t].primaryColor : 'rgba(0, 0, 0, 0.6)',
              color: currentTheme === t ? '#000' : THEMES[t].primaryColor,
              border: `1px solid ${THEMES[t].primaryColor}`,
              borderRadius: '6px',
              padding: '6px 10px',
              cursor: 'pointer',
              fontWeight: 'bold',
              fontSize: '11px',
              letterSpacing: '1px',
              textTransform: 'uppercase',
              boxShadow: currentTheme === t ? `0 0 12px ${THEMES[t].primaryColor}` : 'none',
              transition: 'all 0.3s ease',
            }}
          >
            {t.replace('-', ' ')}
          </button>
        ))}
      </div>
      )}

      {/* Main Hologram SVG Display */}
      <div style={{ width: '100%', height: size, position: 'relative' }}>
        <svg viewBox="0 0 500 500" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
          <defs>
            <filter id={active.glowId} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="5" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <filter id="intense-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="8" result="coloredBlur" />
              <feMerge>
                <feMergeNode in="coloredBlur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            <pattern id="scanlines" width="100" height="4" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="100" y2="0" stroke={active.primaryColor} strokeWidth="1" opacity="0.15" />
            </pattern>

            <style>{`
              @keyframes spinCw { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
              @keyframes spinCcw { from { transform: rotate(360deg); } to { transform: rotate(0deg); } }
              @keyframes pulseCore { 0%, 100% { transform: scale(0.92); opacity: 0.75; } 50% { transform: scale(1.08); opacity: 1; } }
              @keyframes waveOscillate { 0% { transform: scale(1); opacity: 0.3; } 50% { transform: scale(1.15); opacity: 0.8; } 100% { transform: scale(1); opacity: 0.3; } }

              .spin-cw { transform-origin: center; animation: spinCw 20s linear infinite; }
              .spin-ccw { transform-origin: center; animation: spinCcw 12s linear infinite; }
              .spin-fast { transform-origin: center; animation: spinCw 8s linear infinite; }
              .pulse { transform-origin: center; animation: pulseCore 2s ease-in-out infinite; }
              .wave { transform-origin: center; animation: waveOscillate 3s ease-in-out infinite; }
            `}</style>
          </defs>

          {/* Grid background */}
          <rect x="0" y="0" width="500" height="500" fill="url(#scanlines)" opacity="0.6" />

          {/* ========================================================================= */}
          {/* 1. CLASSIC THEME (Original Blueprint Emblem)                              */}
          {/* ========================================================================= */}
          {currentTheme === 'classic' && (
            <g filter={`url(#${active.glowId})`}>
              {/* Outer Calibration Ring */}
              <g className="spin-cw">
                <circle cx="250" cy="250" r="230" fill="none" stroke={active.primaryColor} strokeWidth="1" strokeDasharray="2 8" strokeOpacity="0.4" />
                <circle cx="250" cy="250" r="220" fill="none" stroke={active.primaryColor} strokeWidth="1.5" strokeDasharray="120 15 30 15" strokeOpacity="0.6" />
                <circle cx="250" cy="20" r="4" fill={active.primaryColor} />
                <circle cx="250" cy="480" r="4" fill={active.primaryColor} />
                <circle cx="20" cy="250" r="4" fill={active.primaryColor} />
                <circle cx="480" cy="250" r="4" fill={active.primaryColor} />
              </g>

              {/* Counter-Rotating Ring & Compass Ticks */}
              <g className="spin-ccw">
                <circle cx="250" cy="250" r="195" fill="none" stroke={active.primaryColor} strokeWidth="1.5" strokeOpacity="0.7" strokeDasharray="60 12 8 12 20 12" />
                <path d="M 250 45 L 250 55 M 250 445 L 250 455 M 45 250 L 55 250 M 445 250 L 455 250" stroke={active.primaryColor} strokeWidth="2" />
              </g>

              {/* Arc Reactor Blades */}
              <g className="spin-cw">
                <circle cx="250" cy="250" r="165" fill="none" stroke={active.primaryColor} strokeWidth="1" strokeOpacity="0.5" />
                <path d="M 250 85 A 165 165 0 0 1 415 250" fill="none" stroke={active.primaryColor} strokeWidth="3" />
                <path d="M 250 415 A 165 165 0 0 1 85 250" fill="none" stroke={active.primaryColor} strokeWidth="3" />
                <polygon points="250,75 245,85 255,85" fill={active.primaryColor} />
                <polygon points="250,425 245,415 255,415" fill={active.primaryColor} />
              </g>

              {/* Core Node */}
              <g filter="url(#intense-glow)">
                <circle cx="250" cy="250" r="125" fill="none" stroke={active.primaryColor} strokeWidth="1" strokeOpacity="0.8" strokeDasharray="6 6" />
                <circle cx="250" cy="250" r="95" fill={active.primaryColor} fillOpacity="0.08" stroke={active.primaryColor} strokeWidth="2" />

                <g opacity="0.6" className="spin-ccw">
                  {[0, 36, 72, 108, 144, 180, 216, 252, 288, 324].map((angle) => (
                    <line
                      key={angle}
                      x1={250 + 60 * Math.cos((angle * Math.PI) / 180)}
                      y1={250 + 60 * Math.sin((angle * Math.PI) / 180)}
                      x2={250 + 90 * Math.cos((angle * Math.PI) / 180)}
                      y2={250 + 90 * Math.sin((angle * Math.PI) / 180)}
                      stroke={active.primaryColor}
                      strokeWidth="2"
                    />
                  ))}
                </g>

                <circle cx="250" cy="250" r="55" fill={active.primaryColor} fillOpacity="0.15" stroke={active.primaryColor} strokeWidth="2" />
                <circle cx="250" cy="250" r="24" fill={active.primaryColor} fillOpacity="0.9" className="pulse" />
              </g>
            </g>
          )}

          {/* ========================================================================= */}
          {/* 2. SUPERMAN THEME: Crest of El                                            */}
          {/* ========================================================================= */}
          {currentTheme === 'superman' && (
            <g filter={`url(#${active.glowId})`}>
              <g className="spin-cw">
                <polygon points="250,20 450,135 450,365 250,480 50,365 50,135" fill="none" stroke={active.primaryColor} strokeWidth="1.5" strokeDasharray="15 5 5 5" />
                <circle cx="250" cy="250" r="215" fill="none" stroke={active.secondaryColor} strokeWidth="1" strokeDasharray="100 20" />
              </g>
              <g className="spin-ccw" opacity="0.5">
                {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
                  <line key={angle} x1="250" y1="250" x2={250 + 200 * Math.cos((angle * Math.PI) / 180)} y2={250 + 200 * Math.sin((angle * Math.PI) / 180)} stroke={active.accentColor} strokeWidth="1" strokeDasharray="8 8" />
                ))}
              </g>
              <g className="pulse">
                <polygon points="250,80 400,160 370,390 250,440 130,390 100,160" fill="none" stroke={active.primaryColor} strokeWidth="4" />
                <path d="M 160 180 C 220 120, 340 140, 340 210 C 340 280, 170 260, 170 340 C 170 390, 260 410, 320 370 L 335 320 L 280 320 L 280 340 C 240 355, 210 345, 210 325 C 210 285, 370 280, 370 190 C 370 120, 270 100, 160 140 Z" fill={active.secondaryColor} />
              </g>
            </g>
          )}

          {/* ========================================================================= */}
          {/* 3. DANGER RED THREAT THEME                                                */}
          {/* ========================================================================= */}
          {currentTheme === 'danger-red' && (
            <g filter={`url(#${active.glowId})`}>
              <g className="spin-cw">
                <circle cx="250" cy="250" r="235" fill="none" stroke={active.primaryColor} strokeWidth="3" strokeDasharray="30 15 90 15" />
                <circle cx="250" cy="250" r="210" fill="none" stroke={active.secondaryColor} strokeWidth="1.5" strokeDasharray="60 10 10 10" />
                {[0, 60, 120, 180, 240, 300].map((deg) => (
                  <polygon key={deg} points="250,25 243,12 257,12" fill={active.primaryColor} transform={`rotate(${deg} 250 250)`} />
                ))}
              </g>
              <g className="spin-ccw">
                <circle cx="250" cy="250" r="170" fill="none" stroke={active.primaryColor} strokeWidth="2" strokeDasharray="120 20" />
                <path d="M 250 80 L 250 420 M 80 250 L 420 250" stroke={active.accentColor} strokeWidth="1" strokeDasharray="4 4" opacity="0.6" />
              </g>
              <g className="pulse">
                <circle cx="250" cy="250" r="120" fill="rgba(255,42,0,0.1)" stroke={active.primaryColor} strokeWidth="3" />
                <polygon points="250,160 328,295 172,295" fill="none" stroke={active.secondaryColor} strokeWidth="3" />
                <polygon points="250,340 172,205 328,205" fill="none" stroke={active.secondaryColor} strokeWidth="3" />
                <circle cx="250" cy="250" r="45" fill={active.primaryColor} filter="url(#intense-glow)" />
              </g>
            </g>
          )}

          {/* ========================================================================= */}
          {/* 4. GOKU THEME: Saiyan Scouter                                             */}
          {/* ========================================================================= */}
          {currentTheme === 'goku' && (
            <g filter={`url(#${active.glowId})`}>
              <path d="M 50 250 A 200 200 0 0 1 450 250" fill="none" stroke={active.primaryColor} strokeWidth="4" strokeDasharray="40 10 10 10" />
              <path d="M 70 250 A 180 180 0 0 0 430 250" fill="none" stroke={active.secondaryColor} strokeWidth="2" />
              <g className="spin-fast">
                <circle cx="250" cy="250" r="150" fill="none" stroke={active.primaryColor} strokeWidth="1" strokeDasharray="5 15" />
                <circle cx="250" cy="250" r="130" fill="none" stroke={active.accentColor} strokeWidth="2" strokeDasharray="80 30" />
              </g>
              <g className="wave">
                <circle cx="250" cy="250" r="90" fill="none" stroke={active.secondaryColor} strokeWidth="3" />
                <circle cx="250" cy="250" r="70" fill="none" stroke={active.primaryColor} strokeWidth="1.5" strokeDasharray="12 6" />
              </g>
              <g className="pulse">
                <circle cx="250" cy="250" r="40" fill={active.secondaryColor} fillOpacity="0.2" stroke={active.primaryColor} strokeWidth="3" />
                <line x1="210" y1="250" x2="290" y2="250" stroke={active.primaryColor} strokeWidth="3" />
                <line x1="250" y1="210" x2="250" y2="290" stroke={active.primaryColor} strokeWidth="3" />
                <circle cx="250" cy="250" r="12" fill={active.primaryColor} />
              </g>
            </g>
          )}

          {/* ========================================================================= */}
          {/* 5. RAIDER THEME: Tactical Radar HUD                                       */}
          {/* ========================================================================= */}
          {currentTheme === 'raider' && (
            <g filter={`url(#${active.glowId})`}>
              <g className="spin-cw">
                <polygon points="250,30 470,250 250,470 30,250" fill="none" stroke={active.primaryColor} strokeWidth="2" strokeDasharray="40 10 5 10" />
                <rect x="100" y="100" width="300" height="300" fill="none" stroke={active.secondaryColor} strokeWidth="1" strokeDasharray="20 10" />
              </g>
              <g className="spin-fast">
                <path d="M 250 250 L 400 100 A 212 212 0 0 0 250 38 Z" fill={active.primaryColor} fillOpacity="0.15" />
              </g>
              <g stroke={active.accentColor} strokeWidth="3" fill="none">
                <path d="M 120 160 L 120 120 L 160 120" />
                <path d="M 340 120 L 380 120 L 380 160" />
                <path d="M 120 340 L 120 380 L 160 380" />
                <path d="M 380 340 L 380 380 L 340 380" />
              </g>
              <g className="pulse">
                <circle cx="250" cy="250" r="75" fill="none" stroke={active.primaryColor} strokeWidth="2" strokeDasharray="12 6" />
                <circle cx="250" cy="250" r="25" fill="none" stroke={active.accentColor} strokeWidth="2" />
                <circle cx="250" cy="250" r="8" fill={active.primaryColor} />
              </g>
            </g>
          )}

          {/* ========================================================================= */}
          {/* 6. KRAKEN THEME: Deep Sea Sonar                                           */}
          {/* ========================================================================= */}
          {currentTheme === 'kraken' && (
            <g filter={`url(#${active.glowId})`}>
              <g className="wave">
                <circle cx="250" cy="250" r="220" fill="none" stroke={active.secondaryColor} strokeWidth="1" strokeDasharray="4 8" />
                <circle cx="250" cy="250" r="180" fill="none" stroke={active.primaryColor} strokeWidth="1.5" strokeDasharray="40 20" />
                <circle cx="250" cy="250" r="140" fill="none" stroke={active.accentColor} strokeWidth="2" strokeDasharray="10 10" />
              </g>
              <g className="spin-ccw" opacity="0.8">
                {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
                  <path key={deg} d="M 250 250 Q 290 200, 330 220 T 410 170" fill="none" stroke={active.primaryColor} strokeWidth="2.5" strokeLinecap="round" transform={`rotate(${deg} 250 250)`} />
                ))}
              </g>
              <g className="pulse">
                <ellipse cx="250" cy="250" rx="65" ry="35" fill="rgba(0,255,170,0.1)" stroke={active.primaryColor} strokeWidth="2" />
                <ellipse cx="250" cy="250" rx="20" ry="35" fill={active.accentColor} filter="url(#intense-glow)" />
                <line x1="250" y1="200" x2="250" y2="300" stroke={active.secondaryColor} strokeWidth="1" />
              </g>
            </g>
          )}
        </svg>
      </div>

      {/* Status line. This is all the hologram says by default — see the showReadout prop for
          why it no longer echoes the assistant's reply. */}
      <div style={{ marginTop: '4px', width: '100%', textAlign: 'center', zIndex: 10, position: 'relative' }}>
        <div style={{ fontSize: '14px', fontWeight: 'bold', letterSpacing: '3px', color: active.secondaryColor, textTransform: 'uppercase', marginBottom: '4px', textShadow: `0 0 8px ${active.secondaryColor}` }}>
          {displayName} &bull; {status}
        </div>
        <div style={{ fontSize: '10px', letterSpacing: '2px', color: active.accentColor, opacity: 0.8 }}>
          {active.subtitle}
        </div>

        {showReadout && (
          <div style={{ minHeight: '48px', marginTop: '12px', fontSize: '15px', lineHeight: '1.4', background: 'rgba(0,0,0,0.4)', border: `1px solid ${active.primaryColor}`, borderRadius: '8px', padding: '12px 16px', boxShadow: `inset 0 0 10px rgba(0,0,0,0.8), 0 0 10px ${active.primaryColor}33`, letterSpacing: '0.5px' }}>
            {thinking ? <span style={{ opacity: 0.6, fontStyle: 'italic' }}>RUNNING MATRIX DIAGNOSTICS...</span> : typed}
          </div>
        )}
      </div>
    </div>
  );
}

// Backward-compatible alias exports
// Kept as an alias for anything that imported the old name before this file's theme keys were
// renamed away from their Jarvis-branded originals (see HologramTheme/THEMES above) — nothing
// in this codebase currently uses it.
export const AssistantEmblem = Hologram;
export default Hologram;