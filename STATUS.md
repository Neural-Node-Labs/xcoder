# xcoder — Session Status Report

**Build status as of this zip:** backend typecheck clean, frontend typecheck + build clean,
**680/680 tests passing** (643 prior + 24 new backend tests for route auth coverage and Ollama
model discovery + 13 new frontend tests for speech text sanitisation, covered by the root vitest
config which now reaches `ui/src/**/__tests__` as well). e2e suite (separate from that count)
typechecks clean and now collects 51 specs (49 prior + CHAT-05 + AUTH-07). `mcp-communication` (a
standalone package, not part of the counts above) typechecks, builds, and passes a live MCP
protocol smoke test. Verified live (real running processes, not just static review) at multiple
points — see each section below for exactly what was and wasn't verified that way.

---

## 🔴 Read this first — a critical authentication bypass was found and fixed

While auditing token coverage across the API (your request #3), `/projects/*` and `/plans/*`
turned out to be **completely unauthenticated** — 16 routes reachable with no token at all,
including `GET /projects` (returns 200 and the project list to an anonymous caller) and
unauthenticated file upload, download and delete against project workspaces.

Cause: `createRouter()` registered both sub-routers on its first two lines, ~190 lines *above*
`router.use(authMiddleware)`. An Express Router dispatches in registration order, so those
routes sat in front of the middleware and never reached it. Nothing failed loudly because the
handlers read the caller through a helper that degrades to `{ userId: "", isAdmin: false }` when
`req.user` is absent — so requests executed as a blank pseudo-user, and the tenancy checks
compared ownership against `""`.

This is a different class of bug from the role-check gaps fixed in earlier passes.
`authMiddleware` was always correct and its unit tests always passed; it simply wasn't in the
request path. A unit test of a middleware cannot detect that the middleware was never mounted.

Fixed, plus `GET /engines` (public for the same positional reason). Full writeup and the
reproduction output are in `SECURITY_REVIEW.md` § "Fixed this pass" #0. Guarded going forward by
`src/api/__tests__/routeAuthCoverage.test.ts`, which sweeps every registered route with real
unauthenticated requests against an explicit public allowlist — and which was confirmed to fail
(3/6 cases, listing all 32 exposed pairs) against the pre-fix ordering before the fix landed.

---

## ✅ Complete and verified

### 1. UI fixes
- **Dark-mode dropdown fix** — `<select>` options were rendering white-on-white in dark mode
  (browser-native popup rendering, not following the app's theme). Fixed with explicit
  `color-scheme` + `option` styling in `ui/src/styles.css`.
- **Platform > Tools page** — lists every registered tool, capped at ~5 visible rows with
  scroll (`.tool-list` CSS), showing name/description/source (built-in vs. integration).

### 2. Google Sign-In
- Real ID-token verification server-side via `google-auth-library` (`src/api/googleAuth.ts`) —
  not a stub; rejects forged/expired/wrong-audience tokens.
- Self-service registration AND login through the same `/auth/google` endpoint; first Google
  account on a fresh install becomes admin, same bootstrap rule as local accounts.
- Admins can also pre-link a Google account by email from the Users page (no password) — it
  activates on that person's first Google sign-in.
- Configured via `XCODER_GOOGLE_CLIENT_ID`; login screen hides the button entirely if unset.

### 3. Chat / "assistant" engine
- New `assistant` engine registered in `EngineRegistry.ts` — same bare ReAct loop as `simple`,
  pointed at a conversational system prompt. Full tool/skill/MCP access, no DAG planning.
- New **Chat** tab next to **Task** under Run a Task, talking to `POST /api/v1/chat` with
  `engine: "assistant"`. Client-side transcript replay (no server-side session concept).
- **Verified live**: real end-to-end call through the actual `/api/v1/chat` route with
  `XCODER_MOCK_LLM=1`, confirmed the full pipeline executes (engine routing, Validation Gate,
  health scoring all ran).

### 4. MCP (Model Context Protocol) support
- `mcp_tool` — dependency-free client speaking MCP's JSON-RPC protocol over **two** real
  transports:
  - **stdio**: spawns a local MCP server process per call.
  - **streamable-http**: calls a network MCP server directly (no spawn).
- **Verified live** against a real MCP server: `initialize` → `tools/list` → `tools/call` all
  round-tripped real JSON over both transports, including discovering the actual real tool names
  a live CodeGraph MCP server exposes (`list_projects`, `search_code`, `get_dependencies`, etc.)
  rather than assuming them.
- Gated behind `XCODER_DISABLE_SHELL_TOOLS` alongside `run_command_tool` (same trust class).

### 5. CodeGraph — full integration, three deployment shapes
- **Source fully bundled** in the repo (`integrations/codegraph/` — API server, MCP server,
  pre-built Explorer UI), not just a client pointed at someone else's deployment.
- **docker-compose** (`docker compose up`): `codegraph-api` + `codegraph-mcp` run as their own
  containers, started by default (the old `codegraph` Compose profile was removed — with it,
  the CodeGraph page was permanently empty unless you knew to pass `--profile`). `api` still has
  **no** `depends_on` edge to them, which is what actually fixed the earlier regression where a
  slow/failed CodeGraph blocked xcoder's UI. Residual trade-off: a CodeGraph *image build*
  failure now aborts `docker compose up --build` as a whole.
- **Local dev** (`npm run serve`): one-click "Start bundled CodeGraph" spawns it as a child
  process, auto-authenticates, wires up `codegraph_tool`.
- **External instance**: manual URL + API key entry, or `XCODER_CODEGRAPH_URL` +
  `XCODER_CODEGRAPH_ADMIN_PASSWORD` env vars for auto-connect without any spawn at all.
- **Embedded Explorer UI** at `/codegraph-ui`, SSO'd in via a same-origin localStorage bridge —
  reachable directly from the sidebar (Platform > CodeGraph), with its own status-aware states
  (not bundled / not running / running-but-not-admin / ready).
- **`codegraph_tool`**: full-text search, dependency/impact analysis, symbol path-finding, and
  `action: "index_workspace"` — zips the current project, uploads it, triggers indexing, sets it
  as default. **Verified live** by indexing xcoder's own actual source tree (342 files → 7,323
  real graph nodes) and successfully searching for a real symbol (`runCodegraphTool`) within it.
- **Verified live, full docker-compose-shape simulation**: booted a real `codegraph-api` +
  `codegraph-mcp` (streamable-http mode) + xcoder `api` together, confirmed auto-connect,
  `codegraph_tool` appearing in the tools list, real indexing, and a real MCP tool call all
  working end to end — not just each piece in isolation.

### 6. Web search tool
- `web_search_tool` — real DuckDuckGo search (HTML endpoint, no API key), parses actual organic
  results via `cheerio`, unwraps DuckDuckGo's click-tracking redirect links back to real URLs.
- **Partially verified**: this sandbox's network policy blocks `duckduckgo.com` outright, so the
  live network call itself was never exercised end-to-end from here. What *was* verified: built
  a fixture matching DuckDuckGo's actual current HTML structure (confirmed via research, not
  assumed) and ran the real parsing logic against it successfully.

### 7. Security & deployment hardening (see `SECURITY_REVIEW_INTEGRATIONS.md` for full detail)
- **[Fixed, verified live]** `/codegraph-api` was reachable with no xcoder authentication at
  all — an anonymous caller could brute-force CodeGraph's admin login directly, bypassing
  xcoder's own rate limiter entirely. Fixed with a cookie-based session gate (had to be
  cookie-based, not the usual Bearer-token check, since the actual embedded-UI traffic carries
  CodeGraph's own token, not xcoder's). Verified: anonymous request → 401; same request with a
  real session → passes through correctly.
- **[Fixed]** Path traversal in `index_workspace`'s `path` param — now routed through the same
  `resolveConfinedPath()` every other file tool in the codebase already uses.
- **[Fixed, reviewed by inspection only]** New Docker containers ran as root — now match
  xcoder's own non-root pattern. *Not build-tested* — no Docker daemon available in this
  environment.
- **[Fixed]** No rate limiting on `index-workspace` — now shares the existing task-submission
  limiter.
- **[Documented, needs operator action]** Default CodeGraph admin password ships in
  `docker-compose.yml` — must be overridden via `.env` before any real deployment.

### 8. `securityOpsTool.ts` — Blue Team / Red Team audit tools, now fully wired in
Was fully written but dead code as of the last session (see the old Pending #1 below, kept for
history). This session:
- **`toolSchemas.ts`/`toolDispatcher.ts`**: registered `security_ops_tool` (team, toolId, params)
  so every engine — including `assistant` in Chat — can call it. Gated under
  `XCODER_DISABLE_NETWORK_TOOLS` alongside `codegraph_tool`/`web_search_tool`, since several
  actions (red team's network probes, blue's `cert_expiry_check`) dial out.
- **API routes**: `GET/PUT /api/v1/security-ops/allowlist` (PUT is admin-only) to manage
  `TARGET_ALLOWLIST` from the UI instead of only via the `XCODER_SECOPS_ALLOWLIST` env var, and
  `POST /api/v1/security-ops/run` to run a single check — shares the existing task-submission
  rate limiter.
- **Frontend**: new `ui/src/pages/SecurityOpsPage.tsx` — Blue/Red team tabs, a per-tool form for
  every `toolId` the dispatcher supports, ok/warn/err result display, and an allowlist manager
  (admin-only edits; localhost/127.0.0.1/::1 always shown as protected and non-removable). Wired
  into the sidebar as "Security Ops" under Platform.
- **Tests**: `src/tools/__tests__/securityOpsTool.dispatcher.test.ts` (9 tests) — schema
  presence, real dispatch of an offline blue-team check and the offline password-strength audit,
  the `TARGET_ALLOWLIST` refusal path for an unallowlisted red-team target, the
  `phishing_simulation_sender` not-implemented response, unknown-toolId error shaping, missing
  required args, and both states of the `XCODER_DISABLE_NETWORK_TOOLS` kill switch.
- **Not done this session**: no route-level test for `/security-ops/*` — there's no existing
  `routes.test.ts` convention in this codebase to follow (routes.ts as a whole appears to be
  covered by integration/manual testing rather than unit tests), so I didn't introduce one
  unilaterally rather than half-establishing a new pattern.
- **[Noted, not a live risk]** was the entry under "Noted, not a live risk" in the prior version
  of this file — resolved, see above.

### 9. Docker deployment bugs found and fixed
- **[Real bug, fixed — "pages lose their data when I navigate away"]** `Shell` rendered pages as
  `page === "x" && <X />`, so leaving a page unmounted it and discarded all its state: the task
  draft, the chat transcript, a run in flight, the open Workspace file. Separately, Dashboard's own
  Task/Chat tab switch did the same to the chat panel. Pages are now mounted on first visit and
  kept mounted (hidden with `display: none`; `display: contents` when active so layout is
  unchanged). Consequences handled explicitly: polling pages (Logs, Audit log, CodeGraph status)
  pause while hidden; pages that load on mount refetch when you return (`useOnActivate`) without
  touching drafts/selections; speech output and the mic stop when their panel is hidden; the last
  page is remembered per tab across a reload (`sessionStorage`). The e2e fixture now restricts
  page-level locators to visible elements, since hidden pages stay in the DOM. Covered by
  `ui/src/__tests__/keepAlive.test.tsx` (renders the real `App`; verified to fail against the old
  behavior). Not covered: a full browser reload still loses in-memory drafts — only the current
  page is restored.
- **[Real bug, fixed — "CodeGraph page is blank"]** Four independent causes, all confirmed by
  reading the code and (for the server side) running it: (a) the `api` image never copied
  `codegraph-ui/dist` in, so `/codegraph-ui/` 404'd; (b) `npm run codegraph:ui:build` emitted
  `/assets/...` URLs instead of `/codegraph-ui/assets/...` — the shipped `dist` had been
  hand-built with the right base, so any rebuild produced a blank page; (c) the compose profile
  meant `codegraph-api` wasn't running at all under a plain `docker compose up`; (d) the
  Explorer page hid its "Index this workspace" controls behind the iframe, contradicting e2e
  CG-01, and showed a bare spinner forever if the status call failed. The status endpoint now
  also reports connecting/error state and retries a lost sibling connection on each poll.
- **[Real regression, fixed]** I had wired `api`'s `depends_on` to require `codegraph-api` to be
  *healthy* before starting — meaning if CodeGraph's image was slow/failed to build, xcoder's
  entire UI would never come up. Fixed by removing the dependency edge from `api` entirely (the profile was later
  removed too — see the blank-page entry above).
- **[Real bug, fixed, verified live with a real nginx]** `ui`'s nginx only proxied `/api/`, not
  `/codegraph-ui/`/`/codegraph-api/` — the embedded CodeGraph page would 404 in any Docker
  deployment despite working in local dev. Same gap existed in Vite's dev-server proxy for local
  dev too — both fixed.
- **[Real bug, fixed, verified live with a real nginx]** nginx resolves `proxy_pass` hostnames
  **once, at container startup** with the plain literal-hostname form — if `api` wasn't
  resolvable at that exact instant, nginx crash-looped forever, even after `api` came up. This
  was your actual `host not found in upstream "api"` error. Fixed with Docker's embedded DNS
  resolver (`127.0.0.11`) + a variable-based `proxy_pass`, forcing lazy per-request resolution.
  **Verified with a real installed nginx binary** (not documentation): real `nginx -t` syntax
  check, a real functional test proving paths forward completely unchanged, and a reproduction
  of your exact failure condition confirming nginx now starts successfully and serves a clean
  `502` instead of refusing to boot.
- **[Real bug, fixed, verified with shellcheck + a functional test]** `codegraph-mcp`'s
  `entrypoint.sh` used `export VAR="$(cmd)"` in one statement, which masks the command's real
  exit status behind `export`'s own — so under `set -e`, a failure in the API-key-fetch step
  would silently continue instead of aborting, launching the MCP server with a broken/empty key
  and no clear error. Confirmed the bug was real (old version: exit 0, empty key, silently
  continued) and confirmed the fix (new version: exit 1, aborts immediately) with side-by-side
  functional tests.
- **[Improved diagnosability]** The backend's catch-all 404 used to just say `"Not found"`. Now
  it echoes back the exact method+path received, so any future routing mismatch is immediately
  visible instead of a bare, undiagnosable 404.

### 10. Audit logging for admin actions — now implemented
New `src/api/auditLog.ts`: append-only JSONL trail at `.agent/logs/audit.jsonl` (mirrors
`core/taskHistory.ts`'s existing pattern — read `readAuditLog()`/`appendAuditLog()` there for the
exact shape). Every admin-only mutation now records an entry via a `recordAudit()` helper in
`routes.ts`: CodeGraph connect/disconnect/start/stop, Security Ops allowlist updates, LLM key
set/clear, and user create/update/delete (both local and Google-linked). Each entry has an actor
(id + username, taken from the verified JWT, not request-body-supplied), a machine-readable
dot-namespaced action tag (`user.create`, `codegraph.start`, etc.), a human-readable summary, and
optional structured details — passwords/API keys/tokens are never included in `details`, only
non-secret identifiers (user id, username, role, base URL).
- New `GET /api/v1/audit-log` route, admin-only, same access boundary as `/users`.
- New `AuditLogPage.tsx` in the sidebar's Admin section (admin-only nav item) — filterable by
  actor/action/summary text, auto-refreshing, color-coded badges by action namespace.
- **Deliberately not exposed to any engine/tool** — `security_ops_tool` and friends are callable
  by the LLM; the audit trail recording *its own* admin-triggered actions is not, on the
  reasoning that a log the audited system can also read or influence is a much weaker audit log.
- **Not done**: the bootstrap `/register` route (first-user-becomes-admin, before any token
  exists) is intentionally NOT audited — there's no authenticated actor to attribute it to yet,
  and it only ever fires once per fresh install. Login/logout events also aren't recorded — this
  pass focused on the admin *mutations* the original review flagged, not a general
  authentication audit trail; that'd be a reasonable separate follow-up if you want it.
- **Tests**: `src/api/__tests__/auditLog.test.ts` (7 tests) — empty-log read, round-trip
  persistence, newest-first ordering, the `limit` param, the `MAX_ENTRIES` (5000) cap dropping
  the oldest entries first, tolerating a corrupt line, and confirming no stray `details: undefined`
  gets serialized when a caller omits it.

### 11. Four feature requests: Workspace file browser, LLM provider picker, Project detail + CodeGraph indexing, CodeGraph project selector
- **Workspace file browser** (new). `src/api/workspaceFiles.ts` + a new `WorkspacePage.tsx` in
  the sidebar: pick a project, browse directories (breadcrumbs, directories-first-then-alpha
  sort, `node_modules`/`.git`/`dist`/`build`/`.agent`/`workspace-agent` filtered out of listings
  the same way the zip/index routes already exclude them), open a file into a `<textarea>`
  editor, save, create new files/folders, delete files/folders. Backed by four new routes
  (`GET /workspace/files`, `GET/PUT /workspace/file`, `POST /workspace/dir`,
  `DELETE /workspace/file`). **Security note worth your attention**: this always enforces path
  confinement to the resolved project root, regardless of the `XCODER_RESTRICT_TO_WORKSPACE` env
  var that gates the LLM's own file tools (which defaults *off*, since the agent is trusted with
  full file access by design) — a human clicking around a specific project in a browser needs a
  hard boundary regardless of that setting, so this module doesn't reuse
  `tools/workspaceConfinement.ts` and instead always refuses any path that resolves outside the
  project. Files over 5MB or that look binary (null byte in the first 8KB) are refused rather
  than rendered into the textarea. Root deletion is refused (use the Projects page's "Remove"
  instead). **Not done**: no rate limiting on the write/create/delete routes (read-only
  list/read routes are unlimited by design, same as `/telemetry`, but write/delete probably
  deserve the same task-submission limiter the indexing/security-ops routes use — flagged, not
  applied, since I wasn't sure you'd want file edits throttled the same as task submissions).
- **Settings → LLM provider picker, Ollama as default**. Worth being precise about what changed
  here: **Ollama was already the shipped default provider** in `agent/config/llm.yaml` — nothing
  to fix there. What was missing was a UI to *change* it without hand-editing yaml. New
  `src/api/llmConfigStore.ts` does a targeted, line-level edit of just the top-level scalar keys
  (`provider`, `base_url`, `endpoint`, `model`, `api_key_env`, `max_tokens`, `temperature`) —
  deliberately NOT a full `yaml.load()`/`dump()` round-trip, which would silently strip every one
  of that file's extensive explanatory comments. `overrides`/`fallback` sections are left
  completely untouched. New `GET/PUT /settings/llm-config` + `GET /settings/llm-providers`
  routes (PUT is admin-only, audited). `SettingsPage.tsx` now has a provider dropdown
  (Ollama/OpenAI/Anthropic/DeepSeek/OpenRouter/Groq/custom) that pre-fills known defaults per
  provider. **Not done**: the running server doesn't hot-reload `llm.yaml` — saving here requires
  restarting xcoder's API process to take effect, which the UI's success message says explicitly,
  but there's no restart button; that'd be a reasonable next step if a hot-reload path doesn't
  already exist elsewhere in the config loader.
- **Project detail view + index-for-CodeGraph**. `ProjectsPage.tsx` project rows now expand into
  a detail panel (id, full path, created date, whether it's included when running tasks) with
  "Open in Workspace" (activates the project, then navigates to the new Workspace page) and
  "Index for CodeGraph" buttons. The indexing route itself already existed from an earlier
  session (`POST /platform/integrations/codegraph/index-workspace`) — this was mostly frontend
  wiring plus a per-project result badge.
- **CodeGraph view: project selection**. `CodeGraphExplorerPage.tsx`'s "Index this workspace"
  button previously always indexed whichever project was currently *active* system-wide. It now
  has its own project dropdown, so you can index any of your projects without first having to
  switch your active one on the Projects page.
- **Tests**: `src/api/__tests__/workspaceFiles.test.ts` (17 tests — listing/sorting/exclusion,
  read/write round-trips, binary-file and traversal refusal, mkdir, delete including the
  root-deletion refusal) and `src/api/__tests__/llmConfigStore.test.ts` (9 tests — reading
  current config, `requiresNoAuth`, comment/overrides/fallback preservation across an update,
  confirming `overrides.*.model` is never touched by a top-level `model` edit, appending a
  missing key in the right place, removing a key via empty string, and the missing-file error).
- **Not clicked through in a real browser** — same caveat as everything else added this session:
  typechecked, built, and unit-tested, but I don't have a way to click through the actual
  Workspace file editor, the LLM provider picker, or the expanded project detail panel end to
  end here. Worth a real pass on your end, especially the Workspace page's save/delete flows.

### 12. Task/Chat layout redesign — centered console with a JARVIS-style Hologram
Reworked both the Task and Chat tabs (`Dashboard.tsx`, `ChatPanel.tsx`) into a centered,
Claude.ai-style column instead of the previous full-width two-card grid, and added a new
`Hologram.tsx` component (adapted from a component you supplied) at the top of both tabs as a
JARVIS-style presence — an animated SVG "iris" readout that shows a thinking/scanning state
while a request is in flight and types out a trimmed version of the latest response once it
lands.
- **`Hologram.tsx`**: dropped in close to as-supplied, with one addition — a `showThemeSelector`
  prop (default `true`, set to `false` in both usages here) so the theme-picker button row can be
  hidden when the component is embedded in a fixed spot rather than used as a standalone,
  user-configurable widget. Sized down to 220px for both tabs (the source used 500px, sized for
  being the whole screen). The existing `jarvis-classic` cyan theme was left as the default
  deliberately — xcoder's whole UI is already a cyan/Orbitron/JetBrains-Mono "hologram HUD" theme
  (see `styles.css`'s root variables), so it matches without any changes.
- **Chat tab**: now a centered column — Hologram at top (reflects `busy`/response state), the
  message thread below it in the same bubble style as before, and a pill-shaped, sticky-to-bottom
  input bar (new `.jarvis-input-bar`/`.jarvis-footer` CSS) modeled on the `ChatFooter.tsx` you
  supplied — auto-growing textarea, round send button, Enter-to-send/Shift+Enter-for-newline kept
  from the original. The full reply still renders in the thread below the Hologram; the Hologram
  itself only shows a ~260-char trimmed readout so it doesn't try to cram a huge response into a
  small circular display.
- **Task tab**: same centered shell, Hologram driven by the existing `RunState` phases (idle →
  planning → awaiting-approval → running → done/error), so it visibly "thinks" while a task plans
  or runs and reads out a trimmed summary of the result when it finishes — the full untrimmed
  result still renders in the existing "Result" card underneath, unchanged. The task form itself
  (engine/project/plan-mode/options) is otherwise the same, just narrowed into the centered column
  instead of sitting in a two-column grid.
- **Not carried over from your reference files**: voice input/output (mic button, speech
  recognition, speech synthesis) and the Ollama model-selector dropdown from `ChatFooter.tsx` —
  xcoder's chat already has its own engine/project selectors serving a similar role, and adding a
  second, parallel model picker plus a full voice I/O stack felt like a separate feature decision
  rather than a pure layout change; flagged below if you want either added.
- **Verified**: frontend typecheck clean, frontend build clean (52 modules, no new warnings),
  full backend suite still 624/624 (untouched by this — frontend-only change). **Not verified**:
  no way to click through the actual animation/hologram rendering in a real browser here — the
  SVG animations, typewriter effect, and sticky-footer behavior are unit-untested by nature (this
  is a visual/interaction change) and deserve a real look on your end before you call it done.

### 13. Two previously-pending items closed out: Workspace rate limiting + LLM hot-reload
- **Workspace file browser write/create/delete rate limiting** — `PUT /workspace/file`,
  `POST /workspace/dir`, `DELETE /workspace/file` now share a new `checkWorkspaceRateLimit()` in
  `auth.ts` — deliberately a **separate bucket** from `checkTaskRateLimit()`, not a reuse of it:
  task submission is capped at 30/hour by design (each one kicks off a real LLM-driven run), and
  someone actively editing files in the Workspace page can easily exceed that in a few minutes of
  normal saving, so sharing the bucket would mean editing files eats into the same budget as
  running tasks. The new limit defaults to 300 writes/5min/user
  (`XCODER_WORKSPACE_RATE_MAX` / `XCODER_WORKSPACE_RATE_WINDOW_MS` to override) — generous enough
  for interactive editing, just there to catch a runaway script or compromised session. List/read
  routes remain unlimited, same as `/telemetry`. 5 new tests in `auth.test.ts` cover the
  under/over-limit cases, per-user isolation, the default ceiling, and — importantly — that it's
  genuinely independent from the task rate limiter in both directions.
- **LLM provider config hot-reload — investigated: it already worked, no fix was needed.** Traced
  every call site of `loadLlmConfig()` (all three live in `routes.ts`'s `/chat`, `/chat/plan`,
  and the plan-execute handler) and the function itself: it does a synchronous
  `fs.readFileSync` + `yaml.load` on every single call, with no caching, memoization, or
  module-level state anywhere in the chain. So a provider change saved via Settings **already**
  took effect on the very next request — no restart ever needed. The previous session's stated
  concern (and the Settings page's "restart the server" success message) was simply wrong; fixed
  `SettingsPage.tsx` to say so accurately instead of asserting a restart requirement that doesn't
  exist.
- **Verified**: backend typecheck clean, frontend typecheck + build clean, full suite at
  **629/629** (624 prior + 5 new rate-limit tests).

### 14. Playwright e2e UI suite — scenario catalog + 46 specs
New `ui/e2e/` folder covering the UI end to end, written to close the "never clicked through in
a real browser" gap that pending items #5/#6/#8/#9 had all been accumulating.
- **`ui/e2e/test_scenario.md`** — the scenario catalog and source of truth for *what* is worth
  testing: 11 feature areas, every scenario tagged **Smoke** (basic happy path, run on every
  change) or **Regression** (guards a specific fixed bug or a security/role boundary), each with
  a stable ID (SEC-05, WS-03, …) and a column pointing at the spec that implements it — or `—`
  plus a stated reason when it deliberately isn't automated.
- **11 spec files, 46 tests**: `auth`, `navigation`, `dashboard-task`, `dashboard-chat`,
  `projects`, `workspace`, `codegraph`, `security-ops`, `audit-log`, `settings`, `users`.
- **Security Ops (the requested focus)** gets the deepest coverage — SEC-01..SEC-09, including
  the two that actually matter for trust: **SEC-05** proves a Red Team scan against a
  non-allowlisted target surfaces a `REFUSED` ERR result *in the UI* (the unit tests already
  proved the server refuses; nothing proved the refusal was visible), and **SEC-06** proves
  `phishing_simulation_sender` can never become a runnable form no matter how you switch between
  teams and tools. SEC-07/08/09 pin the admin-vs-non-admin allowlist boundary and the
  non-removable `localhost`/`127.0.0.1`/`::1` entries.
- **`ui/e2e/fixtures.ts`** — shared setup: reads seeded credentials from env vars (never
  hardcoded, so this can point at an instance with real accounts), logs in via the real API and
  injects the session into localStorage under the same keys `AuthContext.tsx` reads. This keeps
  the login *form* as `auth.spec.ts`'s dedicated concern instead of re-testing it in all 46.
- **`ui/e2e/README.md`** — how to start xcoder, seed the two accounts the suite needs (admin +
  non-admin, via the bootstrap `/register` then `/users`), and run. `XCODER_MOCK_LLM=true` is
  the fastest way to get the task/chat specs passing without real model calls.
- **Design notes worth knowing**: `fullyParallel` is off and workers pinned to 1 — several specs
  mutate the same server-side lists (allowlist, projects, users), so concurrency would be flaky
  by construction rather than a real bug. Tests that mutate shared state use timestamp-suffixed
  names and clean up after themselves. `SET-03`/`SET-05` deliberately re-save the *current*
  config / skip when a real key exists, so running the suite never reconfigures the instance
  out from under you. Because xcoder's `<label>`s aren't `htmlFor`-associated with their inputs,
  specs scope through the enclosing `.field` div rather than `getByLabel()`.
- **Also added**: `playwright.config.ts`, `ui/e2e/tsconfig.json` (so specs are typechecked
  without entering the app's production build — the app's own tsconfig only includes `src`),
  `test:e2e` / `test:e2e:ui` / `test:e2e:headed` npm scripts, `@playwright/test` + `@types/node`
  devDeps, and `.gitignore` entries for Playwright run artifacts.
- **Verified**: specs typecheck clean against `ui/e2e/tsconfig.json`; `npx playwright test
  --list` collects all 46 tests across 11 files; the app's own `npm run build` is unaffected.
- **NOT verified — read this before trusting it**: the suite has **never been executed**. No
  running xcoder instance, no browser binary, and no seeded accounts exist in this environment.
  Several locators were inferred from reading components rather than from a live DOM, so expect
  the first real run to surface selector mismatches. See pending #5 — treat the first
  `npm run test:e2e` as the last step of *writing* these tests, not as a verification run.

### 15. `mcp-communication` — new standalone MCP server (Gmail, Drive, Calendar, GitHub, Telegram, WhatsApp)
New package at `integrations/mcp-communication/`, independent of xcoder's own server — an MCP
server any MCP client (xcoder's `mcp_tool`, Claude Desktop, etc.) can spawn over stdio. 19 tools
across six providers: Gmail (list/read/send), Drive (search/read/upload), Calendar (list
events/create/delete), GitHub (search repos, list/get/create issues, comment, read file),
Telegram (send/receive), WhatsApp (send/receive).
- **Credentials are env-var only, never a tool argument** — a model that can be talked into
  passing an attacker's token would otherwise be a straightforward exfiltration path.
- **WhatsApp receiving is structurally different from the rest.** Meta's Cloud API has no
  polling endpoint — inbound messages only ever arrive via a public HTTPS webhook. Built an
  optional webhook listener (`WHATSAPP_WEBHOOK_PORT`) with an in-memory buffer, HMAC signature
  verification when `WHATSAPP_APP_SECRET` is set (warns at startup if it isn't — without it,
  anyone who finds the webhook URL can inject fake messages a model would read and act on), and
  a hard note that this **cannot work at all** under a client that spawns a fresh process per
  call — the buffer dies with the process. Telegram has no such limitation; it polls.
- **Verified live**: MCP handshake negotiates protocol `2024-11-05` (matches xcoder's own
  `mcp_tool` client); all 19 tools list correctly; provider gating hides and refuses calls to
  unconfigured providers; a real outbound call to the GitHub API with a deliberately invalid
  token returned a properly-extracted `401 Bad credentials` through the tool-result path.
- **NOT verified**: no tool has run against a real authenticated account for any of the six
  providers — there are no live credentials in this environment. `README.md` in that folder has
  the full setup for each provider and says explicitly which read-only tool to try first.
- Not yet wired into xcoder's own `SECURITY_REVIEW_INTEGRATIONS.md` or `.env.example` — it's a
  standalone package, not (yet) referenced anywhere else in the xcoder codebase.

### 16. Workspace zip upload — new capability, backend fully tested, frontend unclicked
Added "Upload zip" to the Workspace page: pick a `.zip`, it extracts into whichever directory
you're currently browsing.
- **`extractZipIntoWorkspace()`** in `workspaceFiles.ts` (new `adm-zip` dependency). All-or-
  nothing: one bad entry refuses the whole upload before anything is written, rather than
  leaving a half-extracted mess. Real guards, not just validation theater:
  - **Zip-slip protection** — every entry's path is resolved through the exact same
    `resolveInWorkspace()` confinement every other write in this module already uses. A
    manipulated entry name like `../../evil.txt` is refused, and a unit test proves it (a
    deliberately-crafted malicious fixture, not just an assertion that the code *should* catch
    it — see `workspaceZipUpload.test.ts`).
  - **Zip-bomb protection** — a per-file cap (100MB uncompressed), a total-extraction cap
    (500MB), an entry-count cap (5,000), and a compression-ratio check (>200:1 on anything over
    1MB is refused) that a real highly-compressible payload in the test suite actually trips.
  - `node_modules`/`.git`/etc. inside the zip are skipped (not extracted, not fatal) — same
    exclusion set the file listing already hides.
- New `POST /api/v1/workspace/upload-zip` route: multer multipart upload, the existing workspace
  rate limiter, audit-logged (`workspace.zip_upload`).
- **Tests**: `src/api/__tests__/workspaceZipUpload.test.ts`, 14 tests covering the happy path
  (flat files, nested directories, a target subdirectory), both slip-attack shapes (relative
  escape, baked-in absolute path), the exclusion behavior, every one of the four limits above,
  and rejecting a non-zip/empty-zip buffer.
- **Frontend**: `WorkspacePage.tsx` gained an "Upload zip" button, a hidden file input, and a
  result banner (files/folders extracted, entries skipped). `client.ts` gained a real
  `multipart/form-data` upload path (`uploadForm()`) — the existing `request()` helper always
  JSON-encoded and couldn't carry a file.
- **e2e**: WS-08/09/10 added to `test_scenario.md` and implemented in `workspace.spec.ts` using
  an in-memory zip built with `adm-zip` (added as a `ui` devDependency) fed straight into
  Playwright's `setInputFiles()` — no fixture files on disk, no native file-picker dependency.
- **Verified**: backend typecheck clean, full backend suite **643/643** (629 prior + 14 new),
  backend build clean. Frontend typecheck clean, frontend build clean. e2e specs typecheck
  clean, `playwright test --list` now collects **49** tests (46 prior + 3 new).
- **NOT verified**: same standing caveat as every other UI change this session — nobody has
  actually clicked the Upload zip button in a real browser. The 14 backend tests are the real
  confidence here; the frontend wiring is typechecked and built, not clicked.

### 17. This session's five requests — voice, session expiry, API auth, Hologram, Ollama models

**1. Voice + audio in Chat and Task.** New `ui/src/hooks/useSpeech.ts` provides three
independent capabilities, all built on browser APIs with no new dependencies:
- **Voice input** (`useSpeechRecognition`) — continuous dictation that *appends* to whatever is
  already typed, so you can type half a sentence and finish it by voice. Stops automatically on
  send, so the mic never keeps listening into the next turn.
- **Voice output** (`useSpeechSynthesis`) — reads replies aloud. The interesting part is
  `toSpeakableText()` (extracted to its own dependency-free module, 13 unit tests): fenced code
  blocks become a spoken *"code block omitted"* placeholder rather than being read character by
  character, URLs become "(link)", markdown decoration is stripped, and anything over 700
  characters is truncated at a sentence boundary with "the rest is on screen". Without that,
  voice output is unusable on a coding agent's replies.
- **Sound cues** (`useUiSounds`) — send/receive/error tones synthesised via WebAudio rather than
  shipped as audio assets (three cues are two sine tones each; assets would add bundle weight
  and a licensing question). Gain is ramped, not switched, because an abrupt change clicks.

Both audio features default to **off** and persist per-browser — a tab that starts talking on
its own is worse than one that stays quiet until asked. Every control feature-detects and
renders nothing where unsupported: a mic button that silently does nothing in Firefox is worse
than no mic button, because the user can't tell whether it's the feature or their microphone.

**2. Expired/invalid session logs the user out.** This was the request to "logout the user [so
they can't] access the UI since the api will not work if token is invalid". The old code trusted
a token restored from localStorage, mounted the entire signed-in app, and only discovered the
token was dead when some unrelated request happened to fail — leaving the user inside a UI where
nothing worked, with no explanation and no way back short of clearing localStorage by hand.

Now there's a new `GET /api/v1/auth/me` endpoint and four routes back to the login screen:
1. **Boot check** — the token is verified *before* anything signed-in renders. Catches the
   API-restarted and already-expired cases, which are the common ones.
2. **Scheduled expiry** — `/auth/me` returns `expiresAt`, so the client logs out exactly when
   the token dies rather than on the next failed request. Catches a tab left open past the TTL.
3. **Reactive 401/403** — the pre-existing handler, which still catches admin revocation and
   mid-session restarts.
4. **Tab-focus re-check** — a backgrounded tab is where a session most often dies unnoticed.

One deliberate non-behaviour worth knowing about: a **network failure does not sign you out**. A
dropped connection is not an expired session, and logging someone out mid-task because one probe
couldn't reach the server would lose their work for nothing. Only the server actually rejecting
the token ends the session. The login screen now also explains *why* you're looking at it —
being bounced to a login form with no explanation reads as a bug rather than as a timeout.

**3. API token coverage.** See the callout at the top of this document — this found a critical
bypass. Every route is now behind `authMiddleware` except seven, each of which is required by an
unauthenticated client (credential exchange, the login screen's two pre-auth probes, and
`/health` for the container healthcheck) and each of which is named with its reason in the
allowlist in `routeAuthCoverage.test.ts`.

**4. Hologram — Chat-only, bigger, no duplicated response.** The "response looks like it is
duplicated" was literal: the Hologram typed out a 260-character trimmed copy of the reply while
the identical full reply rendered in the bubble directly beneath it, so every answer was on
screen twice, once clipped. The readout box is gone (`showReadout` now defaults to `false`); the
emblem is a presence indicator — online / processing / listening — and the transcript is the one
place replies live. Size went 220 → 320. For the blending: the emblem used to be drawn as a
rounded card with its own background and `overflow: hidden`, which left a visible seam where its
corners met the page. That's replaced by an absolutely-positioned, blurred, radially-faded glow
layer that reaches nothing to clip against. Removed from the Task tab entirely, where it had
been pushing the actual form below the fold. Both e2e specs now assert the reply text appears
**exactly once** on the page, so the duplication can't come back unnoticed.

**5. Ollama default `granite4:1b` + model picker.** `agent/config/llm.yaml`, the provider
defaults and the compose stack all move to `granite4:1b`. New `src/api/ollamaModels.ts` discovers
models from Ollama's own `/api/tags` and falls back to the compose-pulled list when Ollama is
unreachable or still starting — never an empty picker, since a cold start is exactly when
someone first opens the page. New `GET /api/v1/models` backs the Chat tab's dropdown; `/chat` and
`/chat/plan` accept a `model` override, and the choice carries through to `/chat/execute` via the
plan session so an approved plan runs on the model it was drafted with.

The override is **allowlist-validated against the server's own enumeration**, and an unknown
name is a 400 rather than a silent fallback. Both halves are deliberate: the value is written
straight into the outbound LLM request, so accepting it on trust would let any authenticated user
point the backend at a model the operator never configured — and quietly substituting a different
model would leave the caller believing they got the one they picked, which on a metered endpoint
is a billing question as much as a correctness one.

Three corrections were needed to the compose snippet you supplied, all of which would have
stopped it working:
- A stray `"` after the `smollm2` pull line, and the final `echo` sitting outside the `command:`
  block — both break YAML parsing.
- The snippet dropped `ollama`'s healthcheck, but the `api` service declares
  `depends_on: ollama: condition: service_healthy`. Removing it makes Compose refuse to start.
  A healthcheck is kept, deliberately checking only that the server answers and **not** that any
  model is present — tying "healthy" to model presence would deadlock the whole stack whenever a
  pull failed.
- `ollama_storage` is a named volume in your snippet but was never declared under `volumes:`.

One improvement beyond the snippet: `api` now also waits on
`ollama-pull-model: condition: service_completed_successfully`, so the backend can no longer come
up pointing at an Ollama that hasn't got the default model yet (previously the first chat after a
cold start could fail with model-not-found while the pull was still running). `granite4:1b` is a
required pull — if it fails the sidecar exits non-zero and `api` correctly refuses to start —
while the four alternates are best-effort, so one flaky download can't take the stack down.

`ollamaModels.test.ts` parses `docker-compose.yml` and `llm.yaml` directly and asserts they agree
with the code's fallback list, because these three drift silently: nothing fails at build time if
the default model is changed in one place and not the others.

---

## ⏳ Pending / incomplete / needs your input

### 1. CodeGraph Dockerfile changes — not build-tested
The non-root-user fix for `codegraph-api`/`codegraph-mcp` Dockerfiles follows the exact pattern
already proven working in xcoder's own Dockerfile, and I validated the shell logic and file
ownership reasoning carefully — but there's no Docker daemon in this environment, so `docker
compose build codegraph-api codegraph-mcp` has never actually been run against these changes. **Please
run that build once** before relying on it in production; if `/data` permissions are somehow
still wrong, the fix is a one-line `chown` adjustment.

### 2. `api` container's own crash/unreachability — root cause still unconfirmed
This started the whole nginx investigation: your log showed `ui` failing to resolve `api`. I
found and fixed three real, independent bugs that could each contribute to this class of symptom
(the `depends_on` regression, the nginx resolver bug, and the entrypoint.sh masked-failure bug) —
but I was never able to see `api`'s **own** container logs to confirm which one(s) actually
caused what you saw, or whether there's a fourth thing I haven't found. If you still see any
version of this after pulling this zip and doing a clean rebuild (`docker compose build
--no-cache`), `docker compose logs api` is the single most useful thing you could share next.

### 3. Egress/SSRF hardening for URL-fetching tools
`summarize_url_tool`, `crawl_site_mapper_tool`, and (in principle, though it only ever calls a
fixed DuckDuckGo endpoint) `web_search_tool` can be pointed at internal-only addresses or cloud
metadata endpoints if xcoder runs in a cloud VM. This is a pre-existing consequence of xcoder's
explicit "the agent is trusted, equivalent to shell access" design, not something introduced this
session — documented as a residual risk in the security review, not something I changed, since
narrowing it is a deliberate product decision, not a bug fix.

### 4. `web_search_tool` — never live-network-tested
Covered above — the parsing logic is verified against a real, current DuckDuckGo HTML fixture,
but the actual outbound network call has never executed from this environment (sandbox blocks
the domain). Low risk given how standard the endpoint/pattern is, but worth a real smoke test on
your end.

### 5. Playwright e2e suite written, but never executed against a live instance

> **Updated this session.** Still unrun — no browser binary, no running instance, no seeded
> accounts here, so this remains the single highest-value thing you can do. Three specs were
> *rewritten* this session to match the new intended behaviour and would otherwise have failed
> against it: TASK-01 (asserts the Hologram is **absent** from the Task tab), TASK-02 and
> CHAT-02 (now assert the reply text appears exactly once — the duplication regression guard).
> Two specs are new: CHAT-05 (model picker) and AUTH-07 (a valid restored session survives a
> reload — the inverse guard for AUTH-05, without which "fix" stale sessions by distrusting
> every token would pass). `playwright test --list` collects 51. All of these are newly written
> and inherit the same caveat as the rest: treat the first run as finishing the writing.
The suite that covers #5/#6/#8/#9's old "never clicked through" gap now exists (see §14 below
for what it covers). **It has never actually been run** — there's no running xcoder instance, no
browser binary, and no seeded accounts in this environment, so every spec is verified only to
the extent that it typechecks and that Playwright can parse and collect all 46 tests. Expect a
first run to turn up selector mismatches: several locators had to be inferred from reading the
components rather than from a live DOM, and a handful of things I couldn't verify at all (the
exact button label on the Users page's create form, whether `.tool-row` or a `<tr>` wraps each
user row) are written defensively with alternation to cope with either. **Treat the first
`npm run test:e2e` as part of writing these tests, not as a verification run.**

### 6. Audit log page — covered by the e2e suite, still never executed
`audit-log.spec.ts` implements AUD-01/AUD-02, but per #5 above it's never been run. The
underlying routes and the seven admin-action hooks remain unit- and type-checked only.

### 7. Login/logout audit trail — still not built, still your call

> **Note from this session.** Unchanged, but now slightly more relevant: the session work added
> `GET /auth/me`, which every signed-in browser calls on boot and on every tab focus. If you do
> decide to add an authentication audit trail, that endpoint would be a high-volume, low-signal
> entry — worth excluding explicitly rather than discovering in a full audit table.
The admin-*mutation* audit trail above doesn't cover authentication events (successful/failed
logins, token revocation). Straightforward to add on top of the same `auditLog.ts` if you want
it — didn't add it unprompted since it's a meaningfully bigger trail (every login attempt, not
just admin actions) and a genuine "do we want this" product call, not a bug fix.

### 8. Scenarios documented but deliberately not automated
Six entries in `ui/e2e/test_scenario.md` are catalogued with an implementation of `—`, for three
honest reasons rather than oversight: TASK-06/CHAT-04 need a forced backend failure (wants a
Playwright `route.abort()` mocking layer this suite doesn't have yet), TASK-03 needs a
deterministic mocked planning response, and AUTH-06 would deliberately trip a shared rate limiter
(already covered directly by unit tests in `src/api/__tests__/auth.test.ts`, without needing a
browser). WS-06's excluded-directory check is also only partially exercisable from the browser —
the strong version lives server-side in `workspaceFiles.test.ts`; the spec says so in a comment
rather than asserting something that would pass trivially.

### 9. Hologram/Task/Chat visual layer — voice I/O now built; pure-visual check still needs eyes

**Updated this session.** Voice input, voice output, sound cues, the Chat-only Hologram and the
Ollama model selector are all now implemented — see §17 below. What remains genuinely
unautomatable is the purely visual side: SVG scan-line animation, the emblem's glow blending
into the page, sticky-footer behaviour across viewport sizes. Those need a human eye or a
visual-regression tool, not a DOM assertion.

Two things about the voice work specifically that no test here can cover, because the APIs
don't exist in a headless runner:
- **`SpeechRecognition` has never run.** Its text-processing counterpart (`toSpeakableText`) has
  13 unit tests, but the recognition side is browser-only and Chrome/Edge/Safari-only — there is
  no Firefox implementation at all. The controls feature-detect and hide themselves where it's
  missing, so Firefox degrades to a normal text box, but the actual dictation flow (mic
  permission prompt, interim results, the continuous-listening behaviour) has not been exercised.
- **Audio output has never been heard.** The synthesised cues and speech synthesis are wired and
  typechecked; whether they actually sound right is a judgement call only you can make. Both
  default to **off** and persist per-browser, so nothing makes noise unprompted.

<details>
<summary>Original note from the previous session (kept for context)</summary>
The layout itself now has e2e coverage (TASK-01/02, CHAT-01/02/03), though per #5 it's unrun.
What no automated test addresses is the purely visual side — SVG scan-line animation, the
typewriter effect, sticky-footer behavior under different viewport sizes — which genuinely needs
a human eye or a visual-regression tool, not a DOM assertion. Separately: your reference
`ChatFooter.tsx`/`App.tsx` had voice input (Web Speech API recognition), voice output (speech
synthesis reading replies aloud), and an Ollama model-selector dropdown — none of that was
ported over, on purpose (see §12 for why). If you want the full JARVIS experience — actually
talking to it — that's a real follow-up feature, not a small addition: it'd need a
`useSpeechSynthesis`-equivalent hook, mic permission handling, and a decision about how a
model-selector interacts with xcoder's existing engine/project selectors rather than
duplicating them.
</details>

### 10. `mcp-communication` — never run against a real account, for any of the six providers
Covered in §15 above: 19 tools, live-tested only against the real GitHub API with a deliberately
invalid token (confirms the network/error path works) and a scripted MCP handshake with fake
credentials for the other five (confirms protocol/gating logic, not real behavior). Before
trusting any write-side tool (`gmail_send`, `github_create_issue`, `calendar_delete_event`,
`whatsapp_send`, `telegram_send`, `drive_upload`), run the read-only one for that provider first
— `README.md` in `integrations/mcp-communication/` names exactly which. WhatsApp additionally
needs a publicly reachable webhook to receive anything at all, which is a real deployment step,
not just a credential to paste in.

### 11. Workspace zip upload — backend hardened and tested, frontend never clicked
Covered in §16: the security-critical half (zip-slip, zip-bomb, size limits) has real tests
against deliberately-crafted malicious fixtures, which is the part I'd trust without a manual
pass. The "Upload zip" button, file picker, and result banner in `WorkspacePage.tsx` are
typechecked and built but — same as every other UI change this session — never clicked in an
actual browser. The new WS-08/09/10 e2e specs exist for exactly this reason but haven't been
run either (see pending #5).

---

## File map — everything new this session

```
src/api/googleAuth.ts                  Google ID-token verification
src/api/codegraphKeyStore.ts           CodeGraph connection config (in-memory)
src/api/codegraphProcess.ts            spawn/connect/status/SSO/MCP-launch-resolution
src/api/codegraphProxy.ts              /codegraph-api reverse proxy + auth gate
src/api/securityOpsAllowlistStore.ts   red-team target allowlist (now wired in — see §8)
src/api/auditLog.ts                    admin-action audit trail, JSONL (now wired in — see §10)
src/api/__tests__/auditLog.test.ts     audit log unit tests
src/api/workspaceFiles.ts              workspace file browser backend (list/read/write/mkdir/delete/zip-extract)
src/api/__tests__/workspaceFiles.test.ts  workspace file browser unit tests
src/api/__tests__/workspaceZipUpload.test.ts  zip upload/extract tests (zip-slip, zip-bomb, limits — see §16)
src/api/llmConfigStore.ts              comment-preserving llm.yaml provider config editor
src/api/__tests__/llmConfigStore.test.ts  llm config editor unit tests
src/tools/codegraphTool.ts             codegraph_tool (search/deps/impact/path/index_workspace)
src/tools/mcpTool.ts                   mcp_tool (stdio + streamable-http transports)
src/tools/securityOpsTool.ts           Blue/Red team tools (now wired in — see §8)
src/tools/webSearchTool.ts             web_search_tool (DuckDuckGo)
src/tools/__tests__/securityOpsTool.dispatcher.test.ts  security_ops_tool dispatch tests
integrations/codegraph/                bundled CodeGraph source (API, MCP server, Explorer UI)
ui/src/pages/PlatformToolsPage.tsx     Platform > Tools
ui/src/pages/CodeGraphExplorerPage.tsx embedded CodeGraph Explorer (now with a project picker — see §11)
ui/src/pages/SecurityOpsPage.tsx       Blue/Red Team panel
ui/src/pages/AuditLogPage.tsx          Admin action audit log viewer
ui/src/pages/WorkspacePage.tsx         Workspace file browser (list/edit/create/delete/upload zip — see §16)
ui/src/components/Hologram.tsx         JARVIS-style animated status hologram (Task/Chat header)
ui/src/components/ChatPanel.tsx        Chat tab — now a centered console with the Hologram
ui/e2e/test_scenario.md                smoke + regression scenario catalog (11 areas, IDs)
ui/e2e/fixtures.ts                     shared e2e setup: seeded creds, API login, role fixtures
ui/e2e/README.md                       how to seed accounts and run the suite
ui/e2e/security-ops.spec.ts            SEC-01..09 — incl. the UI-visible REFUSED + not-implemented paths
ui/e2e/*.spec.ts                       10 more specs: auth, navigation, task, chat, projects,
                                       workspace, codegraph, audit-log, settings, users
ui/playwright.config.ts                Playwright config (targets a running instance)
integrations/mcp-communication/        standalone MCP server: Gmail/Drive/Calendar/GitHub/
                                       Telegram/WhatsApp, 19 tools — see §15, has its own README
SECURITY_REVIEW_INTEGRATIONS.md        full security review for everything above
```

## File map — new/changed in THIS session (§17)

```
NEW  src/api/ollamaModels.ts                    Ollama model discovery + allowlist validation
NEW  src/api/__tests__/ollamaModels.test.ts     18 tests: discovery, fallback, compose/config consistency
NEW  src/api/__tests__/routeAuthCoverage.test.ts  6 tests: whole-surface auth sweep (the critical fix)
NEW  ui/src/hooks/useSpeech.ts                  voice input / voice output / sound-cue hooks
NEW  ui/src/hooks/speakableText.ts              pure reply-to-speech sanitiser (extracted for testing)
NEW  ui/src/hooks/__tests__/speakableText.test.ts  13 tests
NEW  ui/src/components/VoiceControls.tsx        mic / speaker / sound-cue buttons + live transcript

CHG  src/api/routes.ts        project+plan routers moved BEHIND authMiddleware (critical);
                              /engines moved behind auth; + GET /auth/me, GET /models;
                              model override on /chat, /chat/plan, /chat/execute
CHG  src/api/types.ts         SessionResponse; `model` on ChatRequest/PlanRequest
CHG  src/api/llmConfigStore.ts  ollama default -> granite4:1b
CHG  agent/config/llm.yaml    model/overrides/fallback -> granite4:1b
CHG  docker-compose.yml       ollama rewritten (named volume, healthcheck kept);
                              NEW ollama-pull-model sidecar; api gates on it
CHG  docker-compose_local.yml granite4:1b
CHG  vitest.config.ts         include ui/src/**/__tests__ (excludes ui/e2e)
CHG  ui/src/context/AuthContext.tsx  boot check, scheduled expiry, focus re-check, expiry flag
CHG  ui/src/App.tsx           Gate renders neither shell nor login while verifying
CHG  ui/src/pages/LoginPage.tsx  "your session ended" notice
CHG  ui/src/pages/Dashboard.tsx  Hologram removed from Task; voice controls + run-state cues
CHG  ui/src/components/ChatPanel.tsx  voice, sounds, model picker, presence-only Hologram
CHG  ui/src/components/Hologram.tsx   showReadout/bleed props; soft glow instead of a card
CHG  ui/src/api/client.ts     session(), models(), `model` on ChatRequest
CHG  ui/src/styles.css        voice controls, session-check screen, task-shell tweaks
CHG  ui/e2e/dashboard-task.spec.ts   TASK-01/02 rewritten
CHG  ui/e2e/dashboard-chat.spec.ts   CHAT-01/02 rewritten, CHAT-05 added
CHG  ui/e2e/auth.spec.ts             AUTH-05 strengthened, AUTH-07 added
CHG  ui/e2e/test_scenario.md         rows updated for the above
CHG  SECURITY_REVIEW.md              new finding #0 (the auth bypass)
```

Plus modifications throughout `routes.ts`, `auth.ts`, `EngineRegistry.ts`, `toolSchemas.ts`,
`toolDispatcher.ts`, `Sidebar.tsx`, `App.tsx`, `Dashboard.tsx` (centered layout + Hologram — see
§12), `LoginPage.tsx`, `UsersPage.tsx`, `ProjectsPage.tsx` (project detail + index button),
`SettingsPage.tsx` (LLM provider picker), `client.ts` (workspace/LLM-config endpoints, and a new
`uploadForm()` multipart path for zip upload — see §16), `styles.css` (`.jarvis-*` classes for
the centered console layout — see §12), `docker-compose.yml`, `nginx.conf`, `vite.config.ts`,
`.env.example`, `README.md`, `package.json` (`adm-zip` — see §16), `ui/package.json`
(`@playwright/test`, `adm-zip` as an e2e devDependency), `src/api/types.ts` (Security Ops, audit
log, workspace files, LLM config, and zip-upload request/response types), `src/config/paths.ts`
(`resolveAuditLogJsonlPath`).
