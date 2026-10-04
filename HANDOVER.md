# xcoder — Handover Notes

This covers everything built across this chat, for continuity in a new conversation. The zip
delivered alongside this file is the full, verified, up-to-date project.

## Verified state (as of this handover)

- Backend: `npm run typecheck` clean, `npm test` → **699/699 passing** (48 test files).
- UI: `npm run typecheck` clean (in `ui/`), `npm test` → **28/28 passing**, `npm run build` clean.
- nginx config (`ui/nginx.conf`) syntax-validated with a real `nginx -t`.
- No `node_modules`/`dist`/`.env` in the zip (gitignored build artifacts — rebuild with `npm
  install && npm run build`, or see `STANDALONE.md` / `scripts/build-standalone.sh`).

## The hologram system (this session's main feature)

**Architecture** — `ui/src/hologramRegistry.ts` is the single source of truth: an array of
`{ id, label, description, Component }`. Settings lists it to build the picker + live preview;
`ChatPanel.tsx` looks up the selected id and renders `<Component {...props} />` through a
`<Suspense>` boundary. Adding a new kind means adding one entry there — nothing else changes.

**The shared contract** every kind implements — `ui/src/components/holograms/types.ts`:
`mood` (required: `"happy"|"sad"|"alert"|"ready"|"attack"|"danger"`), plus `size`, `label`,
`hideLabel`, `assistantName`, `thinking`, `listening`, `bleed`, `className`, `style`. This is
"the property needed by xcoder chat" — every hologram kind must accept all of these.

**Eight selectable kinds:**
1. **Halogram** (default) — `components/Halogram.tsx`. PNG-face artwork under
   `ui/public/halogram/*.png` (happy/sad/ready/danger/mode — a 6th, "prostrated", was dropped;
   it was byte-identical to "sad" in the source mockup).
2. **Abstract HUD** — `components/JarvisHologram.tsx`. Pure CSS/SVG, no image or 3D assets,
   literally portable to other projects (only runtime dependency is React).
3–8. **Six WebGL kinds** under `components/holograms/`: `HalogramChaos`, `HalogramTactical`,
   `HalogramHumanoid`, `HalogramOrbital`, `HalogramMecha`, `HalogramReactorCore`. All built on
   **three.js** (added as a real dependency, `ui/package.json`) via a shared engine hook,
   `useThreeMoodScene.ts`, which handles the renderer/scene/camera/RAF loop/resize/dispose
   boilerplate and a generic mood-transition lerp; each component supplies only its own
   geometry, shaders/materials, and per-mood config values. `HalogramShell.tsx` is the shared
   visual chrome (vignette/scanlines/label/listening-ping) all six render inside.
   - **Performance:** all six are `React.lazy()`-loaded in the registry, so three.js (~700KB)
     is only downloaded if a user actually picks one of them — confirmed via the build output
     (main bundle 268KB; each hologram chunk 2.7–5.7KB; three.js split into its own chunk).

**Mood mapping for the six WebGL kinds** — `components/holograms/moodMapping.ts`. Their source
mockups used a different 6-key convention (`ready/thinking/synthesis/danger/melancholy/
prostrated`) than our app's `JarvisMood`. Mapping: `ready→ready`, `danger→danger`,
`happy→synthesis`, `sad→melancholy`, `alert→thinking`, and **`attack` has no equivalent — it
reuses `danger`'s numeric config with a violet color override** (`ATTACK_COLOR`) rather than a
distinct shape, so attack and danger still read as visually different.

**Trademark neutralization** — the six uploaded source mockups included heavy franchise
branding: "J.A.R.V.I.S.", "STARK INDUSTRIES", "ARC OVERDRIVE", "UNIBEAM", "WAITING FOR SIR",
and Gundam-specific references. Every user-visible string (mood labels, component names,
registry labels) was renamed to something generic; the underlying *shapes* (concentric rings, a
V-crest antenna, a humanoid bust) were kept since geometry isn't trademarked, only the specific
brand names/text. A test (`ui/src/__tests__/hologramRegistry.test.ts`) asserts none of
`jarvis/stark/iron man/gundam/arc reactor/mark-vii` appear in any registry label or description.
This is a continuation of earlier work in the same vein on `Hologram.tsx`'s theme names and the
configurable `assistantName.ts` (default "Xcoder AI", replacing a hardcoded "JARVIS").

**Known fidelity gaps, documented in code comments** (judgment calls, not bugs — easy to
revisit): the "alert" mood on the PNG-face Halogram reuses the danger artwork with only glow
color changed (a hue-rotate was tried, rendered, and visibly failed — reverted); `HalogramOrbital`
synthesizes a "melancholy" config the source mockup didn't define; one shader uniform color
transition (`HalogramChaos`'s core) uses its own ad-hoc smoothing rather than the shared hook's
exact transition curve.

## Voice input (built, wired into ChatPanel)

- **Auto-submit on silence** — always on. `useSpeechRecognition` takes `autoSubmitSilenceMs` +
  `onSilence`; ~1.6s of silence after speech auto-stops and sends.
- **Wake word** — opt-in via a 👂 toggle, off by default, **never persisted** (deliberate — an
  always-listening mic silently resuming after a reload would be a bad surprise). Says the
  configured assistant name to start dictating hands-free. Suspended while dictation is already
  active, a request is in flight, or the assistant is speaking its TTS reply (so it can't hear
  its own voice through open speakers and re-trigger itself).
- Real caveat, not a bug: Web Speech API streams audio to the browser's speech service the
  entire time wake-word is on, not just during dictation — this is inherent to the API, not an
  xcoder choice.

## Mood system (LLM-driven, backend)

- `set_mood_tool` (schema in `toolSchemas.ts`, dispatched in `toolDispatcher.ts`) lets the LLM
  set its own mood during a run. Described to pick a fitting mood, or a random one if unsure,
  rather than skipping the call.
- Persisted per-workspace (`src/tools/moodTool.ts`) until the tool is called again. **Bounded**
  at `MAX_TRACKED_WORKSPACES = 1000` with LRU eviction — found and fixed during the security
  review below; an isolated-workspace run mints a fresh temp cwd each time, so without a bound
  this was an unbounded memory leak.
- Returned as `ChatResponse.mood` / `ExecuteResponse.mood`; `ChatPanel.tsx` renders it live.

## Security review — what was found and fixed this session

1. **`adm-zip` upgraded 0.5.16 → 0.6.1** (root and `ui/package.json`, the latter was test-fixture
   use only). Three known CVEs in <=0.6.0: a 4GB-allocation DoS, uncontrolled memory allocation
   via declared size, and symlink-following extraction. Confirmed via web search exactly which
   call (`entry.getData()`) triggers the worst one, then confirmed (the only real call site,
   `src/api/workspaceFiles.ts`) already checks declared size against a 100MB cap *before*
   calling `getData()` — so this was already mitigated in practice, upgraded anyway as
   defense-in-depth rather than relying solely on that check never regressing. `@types/adm-zip`
   removed (0.6.1 ships its own types).
2. **`moodByWorkspace` memory leak** — found and fixed, see above. New regression tests confirm
   the bound holds and that an actively-read workspace survives eviction.
3. **No CSP / security headers at all** — added to both `src/api/server.ts` (standalone
   deployments) and `ui/nginx.conf` (Docker deployment), kept in sync by hand with cross-
   referencing comments since the two have no shared config source. The CSP's
   `accounts.google.com` carve-outs are copied exactly from **Google's own Identity Services
   docs** (verified via web search, not guessed) — necessary because `style-src` needs
   `'unsafe-inline'` (the app uses inline `style={{}}` extensively) and because an overly strict
   policy would silently break Google Sign-In with no automated-test signal.
   **Not yet smoke-tested in a real browser** (none available in this sandbox) — login with
   Google configured is the one thing worth manually checking after deploying this.
4. **Found a scoping bug in `vitest.config.ts`** caused by my own earlier test file: the root
   test runner's `ui/src/**/__tests__` inclusion was documented as "pure dependency-free logic
   only" (why `.tsx` tests needing jsdom were never swept in), but my new `.ts` test needed
   jsdom too and got caught by the root runner (which lacks it). Fixed by excluding that one
   file by name with a comment explaining why, rather than weakening the general pattern.
5. Re-confirmed (not re-litigated — this had already been reviewed in an earlier session, see
   `SECURITY_REVIEW.md`): auth/token-expiry, SecOps tool allowlisting, zip-slip protection in
   workspace uploads, and the CodeGraph proxy's auth all still check out.

### Security review — completed in follow-up session (see SECURITY_REVIEW.md, 'Follow-up review (2026-10-03)')

(Original 'not yet done' list below is now covered; backend is 703/703 tests after adding the glob guard.)

The review was in progress (dependency audit → CSP → this handover request) when it got cut
off. Not yet covered: a full pass over the newer features' auth/authz specifically (mood tool,
hologram registry endpoints if any, voice features — these are mostly client-side/cosmetic so
likely low-risk, but not explicitly re-verified), rate-limiting review beyond what
`SECURITY_REVIEW.md` already covers, and the `ui` package's own `npm audit` output wasn't fully
triaged the way the root one was (only adm-zip was pulled out and fixed there).

## File manifest — everything touched/added this session

**New files:**
- `ui/src/components/holograms/{types,moodMapping,useThreeMoodScene,HalogramShell}.ts(x)`
- `ui/src/components/holograms/Halogram{Chaos,Tactical,Humanoid,Orbital,Mecha,ReactorCore}.tsx`
- `ui/src/components/Halogram.tsx`, `ui/src/components/JarvisHologram.tsx`
- `ui/src/hologramRegistry.ts` (replaces a deleted `ui/src/hologramStyle.ts`)
- `ui/src/assistantName.ts`, `ui/src/theme.ts`
- `ui/public/halogram/*.png` (5 files)
- `ui/src/__tests__/hologramRegistry.test.ts`
- `src/tools/moodTool.ts`, `src/tools/__tests__/moodTool.test.ts`
- `scripts/build-standalone.sh`, `scripts/install.sh`, `scripts/uninstall.sh`,
  `scripts/xcoder.service.template`, `scripts/xcoder.plist.template`
- `STANDALONE.md`

**Notably modified:**
- `ui/src/components/ChatPanel.tsx` — hologram registry lookup + Suspense, voice auto-submit +
  wake-word wiring, mood state.
- `ui/src/pages/SettingsPage.tsx` — Hologram picker/preview, Assistant name, Theme, LLM config.
- `ui/src/hooks/useSpeech.ts` — `autoSubmitSilenceMs`/`onSilence` options, new `useWakeWord` hook.
- `ui/src/components/VoiceControls.tsx` — new `WakeWordToggle`.
- `src/api/server.ts` — UI static serving + SPA fallback, security headers middleware.
- `src/api/routes.ts` — `mood` field wired into `/chat` and `/chat/execute` responses.
- `src/api/types.ts`, `ui/src/api/client.ts` — `ChatResponse.mood`/`ExecuteResponse.mood`.
- `src/tools/{toolSchemas,toolDispatcher}.ts` — `set_mood_tool` registered.
- `src/api/auth.ts` — token TTL default 7 days → 60 minutes.
- `ui/nginx.conf` — proxy timeouts (60s → 300s, root-caused a reported 504 error), security headers.
- `package.json` / `ui/package.json` — `adm-zip` upgrade, `three`/`@types/three` added.
- `vitest.config.ts` — excluded the one jsdom-requiring new test by name.

## Suggested first steps in the new chat

1. If continuing the security review: pick up from "not yet done" above.
2. If testing the hologram system: `cd ui && npm install && npm run dev`, open Settings, try
   each of the 8 kinds and all 6 moods per kind.
3. Smoke-test Google Sign-in in a real browser if `XCODER_GOOGLE_CLIENT_ID` is configured —
   the CSP change is the one thing in this session that couldn't be verified without one.


---
## Session 3 addendum (2026-10-04)

**State:** backend 794/794 tests, UI 38/38, UI build clean; AGI service builds; nginx config validated with real `nginx -t`; compose overlay validated with `docker compose config`.

1. **SDLC engine hardening + OpenTelemetry** — see `SECURITY_REVIEW.md` ("SDLC engine hardening…"). New: `src/telemetry/{otel,redact,index}.ts`, `src/core/engine/SdlcEngine.ts` (rewritten, API preserved; new stages `ui_ux`, `fix_deployment`; `classifyIntake` now routes defects/failed tests to `fix_defect`), `src/test/{sdlcScenarios,runSdlcScenarios,otlpSmoke}.ts`, tests `SdlcEngineHardening` / `SdlcScenarios`. Scenarios use a **scripted** developer LLM (no API key available) with real tools, real shell gates, real OTel; they have not been run against a live model.
2. **API intake** — `POST /chat` accepts validated `intake` (`hasCode/hasDefect/hasDesign/hasUiDesign/hasFailedTest/hasFailedDeployment/evidence`) and `resumeTaskId` for the sdlc engine (`parseSdlcInput` in routes.ts). **Not yet** wired for `/chat/plan` → `/chat/execute` sessions, the CLI, or the UI Task form (no UI fields to attach evidence yet) — natural next step.
3. **AGI integration** — `integrations/agi/` (vendored, UI removed, token auth + startup guard), `src/api/agiProxy.ts`, `ui/src/components/agi/*`, `docker-compose.agi.yml`, nginx SSE location. Docs: `integrations/agi/XCODER_INTEGRATION.md`.
4. **Not verified:** the Docker images were not built here (no daemon); the AGI tab was exercised against the real services via HTTP and rendered in a headless browser against stubbed API responses, not inside a full compose stack.
